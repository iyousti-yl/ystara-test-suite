import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { buildPipeline, pipelineLogic, planScenario, scenarioInputs, stepNotes } from "@ystara/connector";
import {
  createScenario,
  createScenarioRun,
  deleteScenario,
  getPipeline,
  getScenario,
  getScenarioRun,
  getTenant,
  latestSucceededScan,
  listDatabaseUsers,
  listScenarioRuns,
  listScenarios,
  loadGraph,
  ScenarioNameTaken,
  updateScenario,
  type Db,
} from "@ystara/db";
import {
  JOBS,
  refKey,
  ScenarioSpec,
  scenarioProblems,
  whyNoScenarioRun,
  type LineageGraph,
  type Pipeline,
  type PipelineDefinition,
  type ScenarioCompile,
  type ScenarioDrafted,
  type ScenarioInputs,
  type ScenarioRunJobData,
  type Scan,
} from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import { DraftFailed, type ScenarioDrafter } from "../drafting.js";
import type { JobQueue } from "../server.js";

/**
 * Scenarios of saved pipelines (StoredScenario and ScenarioRun in
 * @ystara/shared), made in the app's builder. Reading them needs
 * "scenarios.read" (every role), saving or deleting one
 * "scenarios.write_visual" (developers, test coordinators and admins).
 * Building one compiles it on the tenant's latest successful scan, from the
 * stored definitions alone: nothing is sent to the tenant. Running one
 * ("runs.execute") queues a job, and the worker sends each check as a SELECT
 * that reads only the scenario's rows. Drafting one from its description
 * ("scenarios.write_visual") sends the pipeline's definitions to Claude when
 * the server has an Anthropic API key (drafting.ts, operator.ts). As everywhere, another
 * account's pipeline, scenario or run answers 404.
 */
const id = z.object({ id: z.string().uuid() });
/** A scenario as the builder sends it: the pipeline comes from the saved pipeline, never from the body. */
const ScenarioDraft = ScenarioSpec.omit({ pipeline: true, version: true });
const DraftRequest = z.object({
  description: z.string().trim().min(1, "Describe the scenario first").max(4000),
  name: z.string().max(200).optional(),
  kind: z.enum(["golden", "common", "outlying"]).optional(),
});

/** Scans don't change once they succeeded, so a few of their graphs are kept for compiling while someone builds. */
const GRAPHS_KEPT = 4;

export function scenarioRoutes(db: Db, queue: JobQueue, drafter: ScenarioDrafter) {
  const graphs = new Map<string, Promise<LineageGraph>>();
  const graphOf = (scanId: string) => {
    let graph = graphs.get(scanId);
    if (!graph) {
      graph = loadGraph(db, scanId, { definitions: true });
      graph.catch(() => graphs.delete(scanId));
      graphs.set(scanId, graph);
      if (graphs.size > GRAPHS_KEPT) graphs.delete(graphs.keys().next().value!);
    }
    return graph;
  };

  /** The pipeline, when its tenant belongs to the signed-in account. */
  async function ownPipeline(req: FastifyRequest, pipelineId: string) {
    const pipeline = await getPipeline(db, pipelineId);
    if (!pipeline) return undefined;
    const tenant = await getTenant(db, pipeline.tenantId);
    return tenant?.accountId === signedIn(req).accountId ? pipeline : undefined;
  }
  async function ownScenario(req: FastifyRequest, scenarioId: string) {
    const scenario = await getScenario(db, scenarioId);
    return scenario && (await ownPipeline(req, scenario.pipelineId)) ? scenario : undefined;
  }

  /** The pipeline built on the tenant's latest successful scan, or why it can't be (409). */
  async function built(pipeline: PipelineDefinition): Promise<{ scan: Scan; graph: LineageGraph; steps: Pipeline } | { error: string }> {
    const scan = await latestSucceededScan(db, pipeline.tenantId);
    if (!scan) return { error: "This tenant has no successful scan yet" };
    const graph = await graphOf(scan.id);
    const { space, technicalName } = pipeline.output;
    if (!graph.nodes.some((n) => n.space === space && n.technicalName === technicalName)) return { error: `${space}.${technicalName} is not in the latest scan` };
    return { scan, graph, steps: buildPipeline(graph, pipeline.output, { excludeWriters: pipeline.excludeWriters }) };
  }

  /** The body as a scenario of the pipeline, or a 400 that lists what is wrong, path by path. */
  function specFrom(pipeline: PipelineDefinition, body: unknown, reply: FastifyReply) {
    try {
      return ScenarioSpec.parse({ ...ScenarioDraft.parse(body), pipeline: refKey(pipeline.output) });
    } catch (e) {
      if (!(e instanceof ZodError)) throw e;
      void reply.code(400).send({ error: "The scenario isn't complete", issues: scenarioProblems(e).map((message) => ({ message })) });
      return undefined;
    }
  }

  return async (app: FastifyInstance) => {
    // What the builder offers: the tables that take rows and the steps a check can be on.
    app.get("/pipelines/:id/scenario-inputs", { config: { access: "scenarios.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      const b = await built(pipeline);
      if ("error" in b) return reply.code(409).send({ error: b.error });
      return { scanId: b.scan.id, drafting: await drafter.available(), ...scenarioInputs(b.graph, b.steps) } satisfies ScenarioInputs;
    });

    // Rows and checks drafted by Claude from a description, compiled on the latest scan and corrected; not saved.
    // A few a minute per person at most: each one costs a call to Claude.
    app.post(
      "/pipelines/:id/scenario-draft",
      { config: { access: "scenarios.write_visual", rateLimit: { max: 5, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (req: FastifyRequest) => signedIn(req).userId } } },
      async (req, reply) => {
        const pipeline = await ownPipeline(req, id.parse(req.params).id);
        if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
        if (!(await drafter.available())) return reply.code(503).send({ error: "Drafting with Claude isn't set up on this server: its operator enters an Anthropic API key on the operator panel" });
        const request = DraftRequest.parse(req.body);
        const b = await built(pipeline);
        if ("error" in b) return reply.code(409).send({ error: b.error });
        const inputs = scenarioInputs(b.graph, b.steps);
        if (!inputs.tables.length) return reply.code(409).send({ error: "No table of this pipeline takes rows, so there is nothing to draft" });
        const output = refKey(pipeline.output);
        const compile = (draft: unknown) => {
          const parsed = ScenarioDraft.safeParse(draft);
          if (!parsed.success) return scenarioProblems(parsed.error);
          const plan = planScenario(b.graph, b.steps, ScenarioSpec.parse({ ...parsed.data, pipeline: output }));
          return [...plan.problems, ...plan.checks.flatMap((c) => (c.problem ? [`The check ${c.label} on ${c.checkpoint}: ${c.problem}`] : []))];
        };
        try {
          const brief = { output, tables: inputs.tables, checkpoints: inputs.checkpoints, logic: pipelineLogic(b.graph, b.steps), today: new Date().toISOString().slice(0, 10) };
          const { usage, ...drafted } = await drafter.draft(brief, request, compile);
          req.log.info({ pipelineId: pipeline.id, usage, problems: drafted.problems.length }, "scenario drafted with Claude");
          return drafted satisfies ScenarioDrafted;
        } catch (e) {
          if (e instanceof DraftFailed) return reply.code(502).send({ error: e.message });
          req.log.error(e, "drafting a scenario with Claude failed");
          return reply.code(502).send({ error: "Claude couldn't be reached to draft the scenario. Try again in a moment." });
        }
      },
    );

    // A scenario compiled as the builder has it now, saved or not. Sends nothing to the tenant.
    app.post("/pipelines/:id/scenario-check", { config: { access: "scenarios.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      const spec = specFrom(pipeline, req.body, reply);
      if (!spec) return reply;
      const b = await built(pipeline);
      if ("error" in b) return reply.code(409).send({ error: b.error });
      const plan = planScenario(b.graph, b.steps, spec);
      return {
        problems: plan.problems,
        checks: plan.checks.map((c) => ({ checkpoint: c.checkpoint, label: c.label, problem: c.problem ?? null })),
        steps: stepNotes(plan.simulation),
      } satisfies ScenarioCompile;
    });

    app.get("/pipelines/:id/scenarios", { config: { access: "scenarios.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      return listScenarios(db, pipeline.id);
    });

    app.post("/pipelines/:id/scenarios", { config: { access: "scenarios.write_visual" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      const spec = specFrom(pipeline, req.body, reply);
      if (!spec) return reply;
      try {
        return reply.code(201).send(await createScenario(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, spec, createdBy: signedIn(req).userId }));
      } catch (e) {
        if (e instanceof ScenarioNameTaken) return reply.code(409).send({ error: e.message });
        throw e;
      }
    });

    app.get("/scenarios/:id", { config: { access: "scenarios.read" } }, async (req, reply) => {
      const scenario = await ownScenario(req, id.parse(req.params).id);
      return scenario ?? reply.code(404).send({ error: "Scenario not found" });
    });

    app.put("/scenarios/:id", { config: { access: "scenarios.write_visual" } }, async (req, reply) => {
      const scenario = await ownScenario(req, id.parse(req.params).id);
      if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
      const spec = specFrom((await getPipeline(db, scenario.pipelineId))!, req.body, reply);
      if (!spec) return reply;
      try {
        const updated = await updateScenario(db, scenario.id, { spec, updatedBy: signedIn(req).userId });
        return updated ?? reply.code(404).send({ error: "Scenario not found" });
      } catch (e) {
        if (e instanceof ScenarioNameTaken) return reply.code(409).send({ error: e.message });
        throw e;
      }
    });

    app.delete("/scenarios/:id", { config: { access: "scenarios.write_visual" } }, async (req, reply) => {
      const scenario = await ownScenario(req, id.parse(req.params).id);
      if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
      await deleteScenario(db, scenario.id);
      return reply.code(204).send();
    });

    // Run the scenario as it is saved. Refused (409) when it can't run, saying why: no scan, the
    // pipeline isn't in it, problems that stop the scenario, or no database user to run it with.
    app.post("/scenarios/:id/runs", { config: { access: "runs.execute" } }, async (req, reply) => {
      const scenario = await ownScenario(req, id.parse(req.params).id);
      if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
      const pipeline = (await getPipeline(db, scenario.pipelineId))!;
      const tenant = (await getTenant(db, pipeline.tenantId))!;
      const why = whyNoScenarioRun(await listDatabaseUsers(db, tenant.id), tenant.host !== null);
      if (why) return reply.code(409).send({ error: why });
      const b = await built(pipeline);
      if ("error" in b) return reply.code(409).send({ error: b.error });
      const { problems } = planScenario(b.graph, b.steps, scenario.spec);
      if (problems.length) return reply.code(409).send({ error: `The scenario can't run: ${problems.join(" ")}` });
      const run = await createScenarioRun(db, scenario, signedIn(req).userId);
      await queue.send(JOBS.scenarioRun, { runId: run.id } satisfies ScenarioRunJobData);
      return reply.code(202).send(run);
    });

    app.get("/scenarios/:id/runs", { config: { access: "runs.read" } }, async (req, reply) => {
      const scenario = await ownScenario(req, id.parse(req.params).id);
      if (!scenario) return reply.code(404).send({ error: "Scenario not found" });
      return listScenarioRuns(db, scenario.id);
    });

    app.get("/scenario-runs/:id", { config: { access: "runs.read" } }, async (req, reply) => {
      const run = await getScenarioRun(db, id.parse(req.params).id);
      if (!run || !(await ownPipeline(req, run.pipelineId))) return reply.code(404).send({ error: "Run not found" });
      return run;
    });
  };
}
