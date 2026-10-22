import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildPipeline, changedSteps } from "@ystara/connector";
import {
  createSignOff,
  getScenarioRun,
  getScenarioSuite,
  getSnapshotDetails,
  latestSucceededScan,
  listPipelines,
  listSignOffs,
  listSnapshots,
  loadGraph,
  pipelineHistory,
  pipelineSummaries,
  signOffBasis,
  type Db,
} from "@ystara/db";
import {
  compareSnapshots,
  refKey,
  toCsv,
  type ChangedStep,
  type HistoryEvent,
  type PipelineDefinition,
  type PipelineHistory,
  type PipelineReport,
  type PipelineSummary,
  type SignOff,
  type SignOffState,
} from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import { scope, space } from "../scope.js";

/**
 * A pipeline's results for whoever answers for them: the Pipelines board (each
 * pipeline's latest results in one call), its history (suites,
 * scenario runs, snapshots and sign-offs on one timeline, also as CSV), its
 * sign-offs, and the report an auditor reads. Reading needs "runs.read" (every
 * role); signing off needs "results.sign_off" (admins and test coordinators).
 * Nothing here calls the tenant.
 */
const id = z.object({ id: z.string().uuid() });
const SignOffInput = z
  .object({
    verdict: z.enum(["approved", "rejected"]),
    comment: z.string().trim().max(2000).default(""),
  })
  .refine((s) => s.verdict === "approved" || s.comment.length > 0, { message: "Say why you reject it", path: ["comment"] });
const read = { access: "runs.read" } as const;
const HISTORY_EVENTS = 100;

export function resultRoutes(db: Db) {
  const own = scope(db);

  /** The steps a later scan changed since the sign-off: empty while it holds, null when its scan is gone or there is no later one to compare. */
  async function changedSince(pipeline: PipelineDefinition, signOff: SignOff | null): Promise<ChangedStep[] | null> {
    if (!signOff?.scan) return null;
    const latest = await latestSucceededScan(db, pipeline.tenantId);
    if (!latest) return null;
    if (latest.id === signOff.scan.id) return [];
    const [before, after] = await Promise.all([loadGraph(db, signOff.scan.id), loadGraph(db, latest.id)]);
    return changedSteps(before, after, pipeline);
  }

  return async (app: FastifyInstance) => {
    // The Pipelines board: each pipeline's latest results (pipelineHealth in @ystara/shared reads them), for the spaces the user sees.
    app.get("/tenants/:id/pipeline-summaries", { config: read }, async (req, reply) => {
      const tenant = await own.tenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const pipelines = new Map((await listPipelines(db, tenant.id)).filter((p) => space(req, p.output.space)).map((p) => [p.id, p]));
      const latest = await latestSucceededScan(db, tenant.id);
      const graphs = new Map<string, ReturnType<typeof loadGraph>>();
      const graph = (scanId: string) => graphs.get(scanId) ?? graphs.set(scanId, loadGraph(db, scanId)).get(scanId)!;
      const summaries = (await pipelineSummaries(db, tenant.id, signedIn(req).userId)).filter((s) => pipelines.has(s.pipelineId));
      return Promise.all(
        summaries.map(async ({ signOff, ...s }): Promise<PipelineSummary> => {
          if (!signOff) return { ...s, signOff: null };
          const { scanId, ...kept } = signOff;
          const later = signOff.verdict === "approved" && scanId && latest && latest.id !== scanId;
          const outdated = later ? changedSteps(await graph(scanId), await graph(latest.id), pipelines.get(s.pipelineId)!).length > 0 : false;
          return { ...s, signOff: { ...kept, outdated } };
        }),
      );
    });

    app.get("/pipelines/:id/signoffs", { config: read }, async (req, reply) => {
      const pipeline = await own.pipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      const all = await listSignOffs(db, pipeline.id);
      const latest = all[0] ?? null;
      return { latest, changedSince: await changedSince(pipeline, latest), basis: await signOffBasis(db, pipeline.id), all } satisfies SignOffState;
    });

    // Signs the pipeline off as it stands: the latest scan, suite and snapshot (signOffBasis). Rejecting needs a reason.
    app.post("/pipelines/:id/signoffs", { config: { access: "results.sign_off" } }, async (req, reply) => {
      const found = await own.pipelineAndTenant(req, id.parse(req.params).id);
      if (!found) return reply.code(404).send({ error: "Pipeline not found" });
      const input = SignOffInput.parse(req.body);
      const basis = await signOffBasis(db, found.pipeline.id);
      if (!basis.scan) return reply.code(409).send({ error: "This tenant has no successful scan yet, so there is nothing to sign off." });
      if (!basis.suite && !basis.snapshot) {
        return reply.code(409).send({ error: "Run the pipeline's scenarios or take a snapshot first: a sign-off covers their results." });
      }
      const signOff = await createSignOff(db, { tenantId: found.tenant.id, pipelineId: found.pipeline.id, ...input, userId: signedIn(req).userId });
      return reply.code(201).send(signOff);
    });

    app.get("/pipelines/:id/history", { config: read }, async (req, reply) => {
      const pipeline = await own.pipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      return { events: await pipelineHistory(db, pipeline.id, HISTORY_EVENTS) } satisfies PipelineHistory;
    });

    app.get("/pipelines/:id/history.csv", { config: read }, async (req, reply) => {
      const pipeline = await own.pipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      const events = await pipelineHistory(db, pipeline.id, 10_000);
      const csv = toCsv(["When (UTC)", "What", "Result", "Passed", "Total", "Output rows", "By", "Comment", "ID"], events.map(historyRow));
      const name = pipeline.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "pipeline";
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="ystara-history-${name}.csv"`)
        .header("cache-control", "no-store")
        .send(csv);
    });

    app.get("/pipelines/:id/report", { config: read }, async (req, reply) => {
      const found = await own.pipelineAndTenant(req, id.parse(req.params).id);
      if (!found) return reply.code(404).send({ error: "Pipeline not found" });
      const { pipeline, tenant } = found;

      const scan = await latestSucceededScan(db, pipeline.tenantId);
      let steps: PipelineReport["steps"] = null;
      if (scan) {
        const graph = await loadGraph(db, scan.id);
        if (graph.nodes.some((n) => refKey(n) === refKey(pipeline.output))) {
          const built = buildPipeline(graph, pipeline.output, { excludeWriters: pipeline.excludeWriters });
          steps = { scanId: scan.id, finishedAt: scan.finishedAt, steps: built.steps.map(({ space, technicalName, type }) => ({ space, technicalName, type })) };
        }
      }

      const signOffs = await listSignOffs(db, pipeline.id, 1);
      const latest = signOffs[0] ?? null;

      const basis = await signOffBasis(db, pipeline.id);
      const suite = basis.suite ? await getScenarioSuite(db, basis.suite.id) : undefined;
      const runs = suite ? await Promise.all(suite.runs.map((r) => getScenarioRun(db, r.id))) : [];

      // The latest two successful snapshots, as the compare page takes them by default.
      const succeeded = (await listSnapshots(db, pipeline.id)).filter((s) => s.status === "succeeded").slice(0, 2);
      let comparison: PipelineReport["comparison"] = null;
      if (succeeded.length === 2) {
        const [after, before] = await Promise.all(succeeded.map((s) => getSnapshotDetails(db, s.id)));
        if (before && after) {
          const c = compareSnapshots(before, after);
          comparison = {
            before: { id: before.id, finishedAt: before.finishedAt },
            after: { id: after.id, finishedAt: after.finishedAt },
            verdict: c.verdict,
            changed: [
              ...c.compared.filter((o) => o.verdict !== "unchanged").map((o) => ({ space: o.space, technicalName: o.technicalName, type: o.type, verdict: o.verdict })),
              ...c.added.map((o) => ({ space: o.space, technicalName: o.technicalName, type: o.type, verdict: "added" as const })),
              ...c.removed.map((o) => ({ space: o.space, technicalName: o.technicalName, type: o.type, verdict: "removed" as const })),
            ],
          };
        }
      }

      return {
        generatedAt: new Date(),
        generatedBy: signedIn(req).email,
        tenant: { id: tenant.id, name: tenant.name, host: tenant.host },
        pipeline,
        steps,
        signOff: { latest, changedSince: await changedSince(pipeline, latest) },
        suite: suite
          ? {
              id: suite.id,
              pipelineId: suite.pipelineId,
              cause: suite.cause,
              status: suite.status,
              requestedAt: suite.requestedAt,
              finishedAt: suite.finishedAt,
              passed: suite.passed,
              total: suite.total,
              runs: runs.flatMap((r) => (r ? [{ id: r.id, scenarioId: r.scenarioId, scenarioName: r.scenarioName, status: r.status, passed: r.passed, total: r.total, error: r.error, checks: r.checks }] : [])),
            }
          : null,
        comparison,
        history: await pipelineHistory(db, pipeline.id, 30),
      } satisfies PipelineReport;
    });
  };
}

/** One history event as a CSV row: When, What, Result, Passed, Total, Output rows, By, Comment, ID. */
function historyRow(e: HistoryEvent) {
  switch (e.kind) {
    case "suite":
      return [e.at, e.cause === "scan" ? "All scenarios, after a scan" : "All scenarios", e.status, e.passed, e.total, null, null, null, e.id];
    case "run":
      return [e.at, `Scenario: ${e.scenarioName}`, e.status, e.passed, e.total, null, null, null, e.id];
    case "snapshot":
      return [e.at, e.scheduled ? "Scheduled snapshot" : "Snapshot", e.status, null, null, e.outputRows, null, e.alert ? "Raised an alert" : null, e.id];
    case "signoff":
      return [e.at, "Sign-off", e.verdict, null, null, null, e.by, e.comment, e.id];
  }
}
