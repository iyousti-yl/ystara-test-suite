import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildPipeline, pipelineGraph, toMermaid } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createTenant,
  deletePipeline,
  deleteTenant,
  getConnection,
  getPipeline,
  getScan,
  getTenant,
  latestSucceededScan,
  listDatabaseUsers,
  listPipelines,
  listScans,
  listTenants,
  loadGraph,
  loadObject,
  watchPipeline,
  type Db,
} from "@ystara/db";
import {
  DATASPHERE_URL_HINT,
  isDatasphereUrl,
  JOBS,
  measurability,
  readableSpaces,
  refKey,
  type PipelineResult,
  type ScanGraph,
  type ScanJobData,
} from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import type { JobQueue } from "../server.js";

/**
 * Tenants, discovery scans, lineage and pipelines, under /api (see server.ts).
 * Response shapes are the types in packages/shared/src/api.ts.
 *
 * The API never talks to Datasphere: a scan request is queued and the worker
 * runs it. Lineage and pipelines are computed here from stored scans, using
 * the connector's pure graph functions (no CLI calls).
 *
 * Everything belongs to the signed-in account: another account's tenant, scan
 * or pipeline answers 404, as if it didn't exist. Reading needs
 * "pipelines.read" (every role); the rest needs the permission named on its route.
 */
const read = { access: "pipelines.read" } as const;
const id = z.object({ id: z.string().uuid() });
export const spaceId = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "Space IDs contain only letters, digits and underscores");
const objectName = z.object({ id: z.string().uuid(), space: spaceId, name: z.string().regex(/^[A-Za-z0-9_]{1,128}$/, "Technical names contain only letters, digits and underscores") });
const objectRef = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/, "Use NAME or SPACE.NAME");
const patterns = z.array(z.string().min(1).max(200)).max(50);

const TenantInput = z.object({
  name: z.string().trim().min(1).max(100),
  // Only a Datasphere tenant: the worker sends it a token and shows what it answers (urls.ts in @ystara/shared).
  host: z.string().trim().refine(isDatasphereUrl, DATASPHERE_URL_HINT),
});
/** Space IDs to scan or check, each once. Also for a tenant's connection (connections.ts). */
export const spaceIds = z
  .array(spaceId)
  .min(1)
  .max(20)
  .transform((spaces) => [...new Set(spaces)]);
const ScanInput = z.object({ spaces: spaceIds });
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
  /** The tenant, when it belongs to the signed-in account. */
  async function ownTenant(req: FastifyRequest, tenantId: string) {
    const tenant = await getTenant(db, tenantId);
    return tenant?.accountId === signedIn(req).accountId ? tenant : undefined;
  }
  /** The scan, when its tenant belongs to the signed-in account. */
  async function ownScan(req: FastifyRequest, scanId: string) {
    const scan = await getScan(db, scanId);
    return scan && (await ownTenant(req, scan.tenantId)) ? scan : undefined;
  }

  return async (app: FastifyInstance) => {
    app.get("/tenants", { config: read }, async (req) => listTenants(db, signedIn(req).accountId));

    app.post("/tenants", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await createTenant(db, { accountId: signedIn(req).accountId, ...TenantInput.parse(req.body) });
      return reply.code(201).send(tenant);
    });

    app.get("/tenants/:id", { config: read }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      return tenant ?? reply.code(404).send({ error: "Tenant not found" });
    });

    // Removes the tenant from Ystara with everything stored for it (deleteTenant). Nothing changes in Datasphere.
    app.delete("/tenants/:id", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      await deleteTenant(db, tenant.id);
      req.log.info({ userId: signedIn(req).userId, accountId: tenant.accountId, tenantId: tenant.id }, "tenant deleted with its scans, pipelines, snapshots and stored secrets");
      return reply.code(204).send();
    });

    app.get("/tenants/:id/scans", { config: read }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return listScans(db, tenant.id);
    });

    app.post("/tenants/:id/scans", { config: { access: "discovery.run" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const { spaces } = ScanInput.parse(req.body);
      // With a technical client, only the spaces its last check could read. (Without one, the worker refuses the scan anyway.)
      const connection = await getConnection(db, tenant.id);
      const readable = connection ? readableSpaces(connection) : undefined;
      const unconfirmed = readable ? spaces.filter((s) => !readable.includes(s)) : [];
      if (unconfirmed.length) {
        const error = `The technical client can't read ${unconfirmed.join(", ")}, or hasn't been checked on it yet. Add the space to the tenant's connection and check again.`;
        return reply.code(409).send({ error });
      }
      const scan = await createScan(db, tenant.id, spaces);
      await queue.send(JOBS.scan, { scanId: scan.id } satisfies ScanJobData);
      return reply.code(202).send(scan);
    });

    app.get("/scans/:id", { config: read }, async (req, reply) => {
      const scan = await ownScan(req, id.parse(req.params).id);
      return scan ?? reply.code(404).send({ error: "Scan not found" });
    });

    app.get("/scans/:id/graph", { config: read }, async (req, reply) => {
      const scan = await ownScan(req, id.parse(req.params).id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      if (scan.status !== "succeeded") return reply.code(409).send({ error: `Scan is ${scan.status}` });
      const graph = await loadGraph(db, scan.id);
      return { ...graph, nodes: graph.nodes.map(({ definition: _definition, ...node }) => node) } satisfies ScanGraph;
    });

    // One object with its definition (as the CLI returned it) and every edge that touches it.
    app.get("/scans/:id/objects/:space/:name", { config: read }, async (req, reply) => {
      const params = objectName.parse(req.params);
      if (!(await ownScan(req, params.id))) return reply.code(404).send({ error: "Scan not found" });
      const details = await loadObject(db, params.id, params.space, params.name);
      return details ?? reply.code(404).send({ error: `${params.space}.${params.name} is not in this scan` });
    });

    // Try a pipeline on one scan before saving it: ?output=SPACE.NAME&excludeWriter=DF_X&excludeWriter=TF_*
    app.get("/scans/:id/pipeline", { config: read }, async (req, reply) => {
      const scan = await ownScan(req, id.parse(req.params).id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      if (scan.status !== "succeeded") return reply.code(409).send({ error: `Scan is ${scan.status}` });
      const query = PipelineQuery.parse(req.query);
      const output = toOutput(query.output, scan.spaces);
      if (!output) return reply.code(400).send({ error: "This scan covers several spaces; use SPACE.NAME" });
      const excludeWriters = patterns.parse(query.excludeWriter === undefined ? [] : [query.excludeWriter].flat());
      const computed = await computePipeline(db, scan, output, excludeWriters);
      return computed ?? reply.code(404).send({ error: `${output.space}.${output.technicalName} is not in this scan` });
    });

    app.get("/tenants/:id/pipelines", { config: read }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return listPipelines(db, tenant.id);
    });

    app.post("/tenants/:id/pipelines", { config: { access: "pipelines.write" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const input = PipelineInput.parse(req.body);
      const [space, technicalName] = input.output.split(".");
      const pipeline = await createPipeline(db, { tenantId: tenant.id, name: input.name, output: { space, technicalName }, excludeWriters: input.excludeWriters });
      await watchPipeline(db, pipeline.id, signedIn(req).userId); // whoever saves a pipeline gets its alerts, until they unwatch it
      return reply.code(201).send(pipeline);
    });

    // A saved pipeline, with its steps computed from the tenant's latest successful scan.
    app.get("/pipelines/:id", { config: read }, async (req, reply) => {
      const definition = await getPipeline(db, id.parse(req.params).id);
      if (!definition || !(await ownTenant(req, definition.tenantId))) return reply.code(404).send({ error: "Pipeline not found" });
      const scan = await latestSucceededScan(db, definition.tenantId);
      if (!scan) return reply.code(409).send({ error: "This tenant has no successful scan yet", definition });
      const computed = await computePipeline(db, scan, definition.output, definition.excludeWriters);
      if (!computed) {
        const { space, technicalName } = definition.output;
        return reply.code(409).send({ error: `${space}.${technicalName} is not in the latest scan`, scanId: scan.id, definition });
      }
      return { definition, ...computed };
    });

    app.delete("/pipelines/:id", { config: { access: "pipelines.write" } }, async (req, reply) => {
      const definition = await getPipeline(db, id.parse(req.params).id);
      if (!definition || !(await ownTenant(req, definition.tenantId))) return reply.code(404).send({ error: "Pipeline not found" });
      await deletePipeline(db, definition.id);
      return reply.code(204).send();
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

/**
 * The pipeline behind `output` in one scan, or undefined when the scan doesn't contain `output`.
 * With, for each step, whether a snapshot can measure it: from what the tenant's database users saw at their last check.
 */
export async function computePipeline(
  db: Db,
  scan: { id: string; tenantId: string },
  output: { space: string; technicalName: string },
  excludeWriters: string[],
): Promise<PipelineResult | undefined> {
  const graph = await loadGraph(db, scan.id);
  if (!graph.nodes.some((n) => n.space === output.space && n.technicalName === output.technicalName)) return undefined;
  const pipeline = buildPipeline(graph, output, { excludeWriters });
  const users = await listDatabaseUsers(db, scan.tenantId);
  const measurement = Object.fromEntries(pipeline.steps.map((step) => [refKey(step), measurability(step, users)]));
  return { scanId: scan.id, excludeWriters, pipeline, graph: pipelineGraph(graph, pipeline), mermaid: toMermaid(graph, pipeline), measurement };
}
