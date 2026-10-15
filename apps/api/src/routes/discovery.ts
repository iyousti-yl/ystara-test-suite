import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildPipeline, pipelineGraph, toMermaid } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createTenant,
  deletePipeline,
  getPipeline,
  getScan,
  getTenant,
  latestSucceededScan,
  listPipelines,
  listScans,
  listTenants,
  loadGraph,
  loadObject,
  type Db,
} from "@ystara/db";
import { JOBS, type PipelineResult, type ScanGraph, type ScanJobData } from "@ystara/shared";
import type { JobQueue } from "../server.js";

/**
 * Tenants, discovery scans, lineage and pipelines, under /api (see server.ts).
 * Response shapes are the types in packages/shared/src/api.ts.
 *
 * The API never talks to Datasphere: a scan request is queued and the worker
 * runs it. Lineage and pipelines are computed here from stored scans, using
 * the connector's pure graph functions (no CLI calls).
 */
const id = z.object({ id: z.string().uuid() });
const spaceId = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "Space IDs contain only letters, digits and underscores");
const objectName = z.object({ id: z.string().uuid(), space: spaceId, name: z.string().regex(/^[A-Za-z0-9_]{1,128}$/, "Technical names contain only letters, digits and underscores") });
const objectRef = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/, "Use NAME or SPACE.NAME");
const patterns = z.array(z.string().min(1).max(200)).max(50);

const TenantInput = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().url().refine((u) => u.startsWith("https://"), "Use the https:// URL of the Datasphere tenant"),
});
const ScanInput = z.object({ spaces: z.array(spaceId).min(1).max(20) });
const PipelineInput = z.object({
  name: z.string().trim().min(1).max(100),
  output: objectRef.refine((o) => o.includes("."), "Use SPACE.NAME"),
  excludeWriters: patterns.default([]),
});
const PipelineQuery = z.object({
  output: objectRef,
  excludeWriter: z.union([z.string(), z.array(z.string())]).optional(),
});

export function discoveryRoutes(db: Db, queue: JobQueue) {
  return async (app: FastifyInstance) => {
    app.get("/tenants", async () => listTenants(db));

    app.post("/tenants", async (req, reply) => {
      const tenant = await createTenant(db, TenantInput.parse(req.body));
      return reply.code(201).send(tenant);
    });

    app.get("/tenants/:id", async (req, reply) => {
      const tenant = await getTenant(db, id.parse(req.params).id);
      return tenant ?? reply.code(404).send({ error: "Tenant not found" });
    });

    app.get("/tenants/:id/scans", async (req, reply) => {
      const tenant = await getTenant(db, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return listScans(db, tenant.id);
    });

    app.post("/tenants/:id/scans", async (req, reply) => {
      const tenant = await getTenant(db, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const scan = await createScan(db, tenant.id, ScanInput.parse(req.body).spaces);
      await queue.send(JOBS.scan, { scanId: scan.id } satisfies ScanJobData);
      return reply.code(202).send(scan);
    });

    app.get("/scans/:id", async (req, reply) => {
      const scan = await getScan(db, id.parse(req.params).id);
      return scan ?? reply.code(404).send({ error: "Scan not found" });
    });

    app.get("/scans/:id/graph", async (req, reply) => {
      const scan = await getScan(db, id.parse(req.params).id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      if (scan.status !== "succeeded") return reply.code(409).send({ error: `Scan is ${scan.status}` });
      const graph = await loadGraph(db, scan.id);
      return { ...graph, nodes: graph.nodes.map(({ definition: _definition, ...node }) => node) } satisfies ScanGraph;
    });

    // One object with its definition (as the CLI returned it) and every edge that touches it.
    app.get("/scans/:id/objects/:space/:name", async (req, reply) => {
      const params = objectName.parse(req.params);
      const details = await loadObject(db, params.id, params.space, params.name);
      return details ?? reply.code(404).send({ error: `${params.space}.${params.name} is not in this scan` });
    });

    // Try a pipeline on one scan before saving it: ?output=SPACE.NAME&excludeWriter=DF_X&excludeWriter=TF_*
    app.get("/scans/:id/pipeline", async (req, reply) => {
      const scan = await getScan(db, id.parse(req.params).id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      if (scan.status !== "succeeded") return reply.code(409).send({ error: `Scan is ${scan.status}` });
      const query = PipelineQuery.parse(req.query);
      const output = toOutput(query.output, scan.spaces);
      if (!output) return reply.code(400).send({ error: "This scan covers several spaces; use SPACE.NAME" });
      const excludeWriters = patterns.parse(query.excludeWriter === undefined ? [] : [query.excludeWriter].flat());
      const computed = await computePipeline(db, scan.id, output, excludeWriters);
      return computed ?? reply.code(404).send({ error: `${output.space}.${output.technicalName} is not in this scan` });
    });

    app.get("/tenants/:id/pipelines", async (req, reply) => {
      const tenant = await getTenant(db, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return listPipelines(db, tenant.id);
    });

    app.post("/tenants/:id/pipelines", async (req, reply) => {
      const tenant = await getTenant(db, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const input = PipelineInput.parse(req.body);
      const [space, technicalName] = input.output.split(".");
      const pipeline = await createPipeline(db, { tenantId: tenant.id, name: input.name, output: { space, technicalName }, excludeWriters: input.excludeWriters });
      return reply.code(201).send(pipeline);
    });

    // A saved pipeline, with its steps computed from the tenant's latest successful scan.
    app.get("/pipelines/:id", async (req, reply) => {
      const definition = await getPipeline(db, id.parse(req.params).id);
      if (!definition) return reply.code(404).send({ error: "Pipeline not found" });
      const scan = await latestSucceededScan(db, definition.tenantId);
      if (!scan) return reply.code(409).send({ error: "This tenant has no successful scan yet", definition });
      const computed = await computePipeline(db, scan.id, definition.output, definition.excludeWriters);
      if (!computed) {
        const { space, technicalName } = definition.output;
        return reply.code(409).send({ error: `${space}.${technicalName} is not in the latest scan`, scanId: scan.id, definition });
      }
      return { definition, ...computed };
    });

    app.delete("/pipelines/:id", async (req, reply) => {
      const deleted = await deletePipeline(db, id.parse(req.params).id);
      return deleted ? reply.code(204).send() : reply.code(404).send({ error: "Pipeline not found" });
    });
  };
}

/** NAME or SPACE.NAME; a bare NAME is only clear when the scan covers one space. */
function toOutput(output: string, spaces: string[]): { space: string; technicalName: string } | undefined {
  if (output.includes(".")) {
    const [space, technicalName] = output.split(".");
    return { space, technicalName };
  }
  return spaces.length === 1 ? { space: spaces[0], technicalName: output } : undefined;
}

/** The pipeline behind `output` in one scan, or undefined when the scan doesn't contain `output`. */
async function computePipeline(
  db: Db,
  scanId: string,
  output: { space: string; technicalName: string },
  excludeWriters: string[],
): Promise<PipelineResult | undefined> {
  const graph = await loadGraph(db, scanId);
  if (!graph.nodes.some((n) => n.space === output.space && n.technicalName === output.technicalName)) return undefined;
  const pipeline = buildPipeline(graph, output, { excludeWriters });
  return { scanId, excludeWriters, pipeline, graph: pipelineGraph(graph, pipeline), mermaid: toMermaid(graph, pipeline) };
}
