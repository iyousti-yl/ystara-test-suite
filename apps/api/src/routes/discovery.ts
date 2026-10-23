import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildPipeline, pipelineGraph, toMermaid } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createTenant,
  deletePipeline,
  deleteScanSchedule,
  deleteTenant,
  getConnection,
  getScanSchedule,
  hasUnfinishedScan,
  latestSucceededScan,
  listDatabaseUsers,
  listPipelines,
  listScans,
  listTenants,
  loadGraph,
  loadObject,
  setIgnoredLoaders,
  setScanSchedule,
  watchPipeline,
  type Db,
} from "@ystara/db";
import {
  checkSchedule,
  DATASPHERE_URL_HINT,
  isDatasphereUrl,
  JOBS,
  measurability,
  MIN_MINUTES_BETWEEN_SCANS,
  readableSpaces,
  refKey,
  type PipelineResult,
  type Scan,
  type ScanGraph,
  type ScanJobData,
} from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import { allSpaces, scope, space } from "../scope.js";
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
 * or pipeline answers 404, as if it didn't exist (scope.ts). A member limited
 * to some spaces sees only those spaces' objects in a scan and pipelines whose
 * output is in one of them, with every step of such a pipeline. Reading needs "pipelines.read" (every role); the
 * rest needs the permission named on its route.
 */
const read = { access: "pipelines.read" } as const;
const id = z.object({ id: z.string().uuid() });
export const spaceId = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "Space IDs contain only letters, digits and underscores");
const objectName = z.object({ id: z.string().uuid(), space: spaceId, name: z.string().regex(/^[A-Za-z0-9_]{1,128}$/, "Technical names contain only letters, digits and underscores") });
const objectRef = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/, "Use NAME or SPACE.NAME");
const ObjectQuery = z.object({ within: objectRef.optional() });
/** ?before=<the requestedAt of the oldest row shown>: the next page of older rows. */
export const Page = z.object({ before: z.coerce.date().optional() });

/** A scan older than this that is still queued or running is taken as stuck (the worker's sweep ends it) and no longer stops a new one. */
const SCAN_STUCK_MS = 5 * 60 * 60_000;

/**
 * A scan as a member limited to some spaces may see it: their spaces only, the warnings about those, and no error
 * text, which can name any space's objects. Null when the scan read none of their spaces.
 */
export function scanFor(req: FastifyRequest, scan: Scan): Scan | null {
  if (allSpaces(req)) return scan;
  const spaces = scan.spaces.filter((s) => space(req, s));
  if (!spaces.length) return null;
  // Warnings start with the space they are about: "SALES: could not list ..." or "SALES.V_ORDERS (view): ...".
  const warnings = scan.warnings.filter((w) => space(req, w.split(/[.:]/)[0]));
  return { ...scan, spaces, warnings, error: scan.error && "The scan failed. An admin can see why on this page." };
}
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
const ScanScheduleBody = z.object({ cron: z.string().max(200), timeZone: z.string().max(100) });
const PipelineInput = z.object({
  name: z.string().trim().min(1).max(100),
  output: objectRef.refine((o) => o.includes("."), "Use SPACE.NAME"),
  excludeWriters: patterns.default([]),
});
const IgnoredLoaders = z.object({ excludeWriters: patterns }).strict();
const PipelineQuery = z.object({
  output: objectRef,
  excludeWriter: z.union([z.string(), z.array(z.string())]).optional(),
});

/** A scan schedule scans every space the technical client reads, so only someone who sees every space may set it. */
const SCHEDULE_NEEDS_ALL_SPACES = "Only someone who sees every space can change the scan schedule: it scans them all.";

export function discoveryRoutes(db: Db, queue: JobQueue) {
  const own = scope(db);
  const ownTenant = own.tenant;
  const ownScan = own.scan;

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
      const { before } = Page.parse(req.query);
      return (await listScans(db, tenant.id, { before })).map((s) => scanFor(req, s)).filter((s) => s !== null);
    });

    app.post("/tenants/:id/scans", { config: { access: "discovery.run" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const { spaces } = ScanInput.parse(req.body);
      const hidden = spaces.filter((s) => !space(req, s));
      if (hidden.length) return reply.code(403).send({ error: `You can't scan ${hidden.join(", ")}: your access is limited to other spaces.` });
      // With a technical client, only the spaces its last check could read. (Without one, the worker refuses the scan anyway.)
      const connection = await getConnection(db, tenant.id);
      const readable = connection ? readableSpaces(connection) : undefined;
      const unconfirmed = readable ? spaces.filter((s) => !readable.includes(s)) : [];
      if (unconfirmed.length) {
        const error = `The technical client can't read ${unconfirmed.join(", ")}, or hasn't been checked on it yet. Add the space to the tenant's connection and check again.`;
        return reply.code(409).send({ error });
      }
      // One scan of a tenant at a time: a second would read the same spaces again, at the same moment.
      if (await hasUnfinishedScan(db, tenant.id, new Date(Date.now() - SCAN_STUCK_MS))) {
        return reply.code(409).send({ error: "A scan of this tenant is still running. Start the next one once it has finished." });
      }
      const scan = await db.transaction(async (tx) => {
        const created = await createScan(tx, tenant.id, spaces);
        await queue.send(JOBS.scan, { scanId: created.id } satisfies ScanJobData, tx);
        return created;
      });
      return reply.code(202).send(scan);
    });

    // The tenant's scan schedule, or null when it is only scanned by hand.
    app.get("/tenants/:id/scan-schedule", { config: read }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return { schedule: (await getScanSchedule(db, tenant.id)) ?? null };
    });

    // Set or replace it. Each run scans the spaces the technical client could read at its last check, so a
    // tenant needs a connected client first (409); runs must be MIN_MINUTES_BETWEEN_SCANS apart (400).
    app.put("/tenants/:id/scan-schedule", { config: { access: "discovery.run" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!allSpaces(req)) return reply.code(403).send({ error: SCHEDULE_NEEDS_ALL_SPACES });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const body = ScanScheduleBody.parse(req.body);
      const check = checkSchedule(body.cron, body.timeZone, new Date(), 5, MIN_MINUTES_BETWEEN_SCANS);
      if (!check.ok) return reply.code(400).send({ error: check.error });
      const connection = await getConnection(db, tenant.id);
      if (!connection || !readableSpaces(connection).length) {
        return reply.code(409).send({ error: "Scheduled scans read the spaces the tenant's technical client can read, and it has none yet. Connect it under Connection › Technical client first." });
      }
      const schedule = await setScanSchedule(db, { tenantId: tenant.id, cron: check.cron, timeZone: body.timeZone, nextRunAt: check.next[0], updatedBy: signedIn(req).userId });
      return { schedule };
    });

    app.delete("/tenants/:id/scan-schedule", { config: { access: "discovery.run" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!allSpaces(req)) return reply.code(403).send({ error: SCHEDULE_NEEDS_ALL_SPACES });
      await deleteScanSchedule(db, tenant.id);
      return reply.code(204).send();
    });

    app.get("/scans/:id", { config: read }, async (req, reply) => {
      const scan = await ownScan(req, id.parse(req.params).id);
      const visible = scan && scanFor(req, scan);
      return visible ?? reply.code(404).send({ error: "Scan not found" });
    });

    app.get("/scans/:id/graph", { config: read }, async (req, reply) => {
      const scan = await ownScan(req, id.parse(req.params).id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      if (scan.status !== "succeeded") return reply.code(409).send({ error: `Scan is ${scan.status}` });
      const graph = await loadGraph(db, scan.id);
      // Only the spaces the user sees, and the links between them.
      const nodes = graph.nodes.filter((n) => space(req, n.space));
      const edges = graph.edges.filter((e) => space(req, e.from.space) && space(req, e.to.space));
      return { ...graph, nodes: nodes.map(({ definition: _definition, ...node }) => node), edges } satisfies ScanGraph;
    });

    // One object with its definition (as the CLI returned it) and every edge that touches it.
    // ?within=SPACE.NAME: opened from that output's pipeline, whose steps a member sees whatever their space.
    app.get("/scans/:id/objects/:space/:name", { config: read }, async (req, reply) => {
      const params = objectName.parse(req.params);
      const { within } = ObjectQuery.parse(req.query);
      const scan = await ownScan(req, params.id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      const steps = new Set<string>();
      const output = within && toOutput(within, scan.spaces);
      if (output && space(req, output.space) && !allSpaces(req) && scan.status === "succeeded") {
        const graph = await loadGraph(db, scan.id);
        if (graph.nodes.some((n) => refKey(n) === refKey(output))) {
          for (const n of pipelineGraph(graph, buildPipeline(graph, output, { excludeWriters: [] })).nodes) steps.add(refKey(n));
        }
      }
      const sees = (ref: { space: string; technicalName: string }) => space(req, ref.space) || steps.has(refKey(ref));
      const details = sees({ space: params.space, technicalName: params.name }) ? await loadObject(db, params.id, params.space, params.name) : undefined;
      if (!details) return reply.code(404).send({ error: `${params.space}.${params.name} is not in this scan` });
      return { ...details, edges: details.edges.filter((e) => sees(e.from) && sees(e.to)) };
    });

    // Try a pipeline on one scan before saving it: ?output=SPACE.NAME&excludeWriter=DF_X&excludeWriter=TF_*
    app.get("/scans/:id/pipeline", { config: read }, async (req, reply) => {
      const scan = await ownScan(req, id.parse(req.params).id);
      if (!scan) return reply.code(404).send({ error: "Scan not found" });
      if (scan.status !== "succeeded") return reply.code(409).send({ error: `Scan is ${scan.status}` });
      const query = PipelineQuery.parse(req.query);
      const output = toOutput(query.output, scan.spaces);
      if (!output) return reply.code(400).send({ error: "This scan covers several spaces; use SPACE.NAME" });
      if (!space(req, output.space)) return reply.code(404).send({ error: `${output.space}.${output.technicalName} is not in this scan` });
      const excludeWriters = patterns.parse(query.excludeWriter === undefined ? [] : [query.excludeWriter].flat());
      const computed = await computePipeline(db, scan, output, excludeWriters);
      return computed ?? reply.code(404).send({ error: `${output.space}.${output.technicalName} is not in this scan` });
    });

    app.get("/tenants/:id/pipelines", { config: read }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return (await listPipelines(db, tenant.id)).filter((p) => space(req, p.output.space));
    });

    app.post("/tenants/:id/pipelines", { config: { access: "pipelines.write" } }, async (req, reply) => {
      const tenant = await ownTenant(req, id.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const input = PipelineInput.parse(req.body);
      const [outputSpace, technicalName] = input.output.split(".");
      if (!space(req, outputSpace)) return reply.code(403).send({ error: `You can't save a pipeline in ${outputSpace}: your access is limited to other spaces.` });
      const pipeline = await createPipeline(db, { tenantId: tenant.id, name: input.name, output: { space: outputSpace, technicalName }, excludeWriters: input.excludeWriters });
      await watchPipeline(db, pipeline.id, signedIn(req).userId); // whoever saves a pipeline gets its alerts, until they unwatch it
      return reply.code(201).send(pipeline);
    });

    // A saved pipeline, with its steps computed from the tenant's latest successful scan.
    app.get("/pipelines/:id", { config: read }, async (req, reply) => {
      const definition = await own.pipeline(req, id.parse(req.params).id);
      if (!definition) return reply.code(404).send({ error: "Pipeline not found" });
      const scan = await latestSucceededScan(db, definition.tenantId);
      if (!scan) return reply.code(409).send({ error: "This tenant has no successful scan yet", definition });
      const computed = await computePipeline(db, scan, definition.output, definition.excludeWriters);
      if (!computed) {
        const { space, technicalName } = definition.output;
        return reply.code(409).send({ error: `${space}.${technicalName} is not in the latest scan`, scanId: scan.id, definition });
      }
      return { definition, ...computed };
    });

    // The loaders a saved pipeline ignores, changed in place: saving the pipeline again from a scan would make a second one.
    app.put("/pipelines/:id/ignored-loaders", { config: { access: "pipelines.write" } }, async (req, reply) => {
      const definition = await own.pipeline(req, id.parse(req.params).id);
      if (!definition) return reply.code(404).send({ error: "Pipeline not found" });
      const { excludeWriters } = IgnoredLoaders.parse(req.body);
      return await setIgnoredLoaders(db, definition.id, [...new Set(excludeWriters)]);
    });

    app.delete("/pipelines/:id", { config: { access: "pipelines.write" } }, async (req, reply) => {
      const definition = await own.pipeline(req, id.parse(req.params).id);
      if (!definition) return reply.code(404).send({ error: "Pipeline not found" });
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
