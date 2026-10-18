import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createSnapshot, getPipeline, getSnapshotDetails, getTenant, latestSucceededScan, listSnapshots, type Db } from "@ystara/db";
import { compareSnapshots, JOBS, whyNothingMeasurable, type SnapshotComparison, type SnapshotJobData } from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import type { JobQueue } from "../server.js";
import { computePipeline } from "./discovery.js";

/**
 * Snapshots of saved pipelines (Snapshot in @ystara/shared): taking one
 * ("runs.execute") queues a job, and the worker measures the steps the
 * database users can see. Reading them, and comparing two of them, needs
 * "runs.read" (every role). As everywhere, another account's pipeline or
 * snapshot answers 404.
 */
const id = z.object({ id: z.string().uuid() });
const ComparePair = z
  .object({ from: z.string().uuid().optional(), to: z.string().uuid().optional() })
  .refine((q) => (q.from === undefined) === (q.to === undefined), "Give both from and to, or neither for the latest two snapshots");

export function snapshotRoutes(db: Db, queue: JobQueue) {
  /** The pipeline and its tenant, when the tenant belongs to the signed-in account. */
  async function ownPipelineAndTenant(req: FastifyRequest, pipelineId: string) {
    const pipeline = await getPipeline(db, pipelineId);
    if (!pipeline) return undefined;
    const tenant = await getTenant(db, pipeline.tenantId);
    return tenant?.accountId === signedIn(req).accountId ? { pipeline, tenant } : undefined;
  }
  const ownPipeline = async (req: FastifyRequest, pipelineId: string) => (await ownPipelineAndTenant(req, pipelineId))?.pipeline;

  return async (app: FastifyInstance) => {
    app.get("/pipelines/:id/snapshots", { config: { access: "runs.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      return listSnapshots(db, pipeline.id);
    });

    // Take a snapshot now. Refused when none of the steps can be measured, saying what would change that.
    app.post("/pipelines/:id/snapshots", { config: { access: "runs.execute" } }, async (req, reply) => {
      const own = await ownPipelineAndTenant(req, id.parse(req.params).id);
      if (!own) return reply.code(404).send({ error: "Pipeline not found" });
      const { pipeline, tenant } = own;
      const scan = await latestSucceededScan(db, pipeline.tenantId);
      if (!scan) return reply.code(409).send({ error: "This tenant has no successful scan yet" });
      const computed = await computePipeline(db, scan, pipeline.output, pipeline.excludeWriters);
      if (!computed) return reply.code(409).send({ error: `${pipeline.output.space}.${pipeline.output.technicalName} is not in the latest scan` });
      if (!Object.values(computed.measurement).some((m) => m.measurable)) {
        return reply.code(409).send({ error: whyNothingMeasurable(computed.pipeline.steps, computed.measurement, tenant.host !== null) });
      }
      const snapshot = await createSnapshot(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: signedIn(req).userId });
      await queue.send(JOBS.snapshot, { snapshotId: snapshot.id } satisfies SnapshotJobData);
      return reply.code(202).send(snapshot);
    });

    // Two stored snapshots of the pipeline compared (compareSnapshots in @ystara/shared): read-only, no tenant call.
    // Without from and to, the latest two that succeeded, the older one first.
    app.get("/pipelines/:id/compare", { config: { access: "runs.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      let { from, to } = ComparePair.parse(req.query);
      if (!from || !to) {
        const latest = (await listSnapshots(db, pipeline.id)).filter((s) => s.status === "succeeded");
        if (latest.length < 2) return reply.code(409).send({ error: "This pipeline needs two successful snapshots to compare" });
        [to, from] = [latest[0].id, latest[1].id];
      }
      const [before, after] = await Promise.all([getSnapshotDetails(db, from), getSnapshotDetails(db, to)]);
      if (!before || !after || before.pipelineId !== pipeline.id || after.pipelineId !== pipeline.id) {
        return reply.code(404).send({ error: "Snapshot not found for this pipeline" });
      }
      const unfinished = [before, after].find((s) => s.status === "queued" || s.status === "running");
      if (unfinished) return reply.code(409).send({ error: "A snapshot can be compared once it has finished" });
      return compareSnapshots(before, after) satisfies SnapshotComparison;
    });

    app.get("/snapshots/:id", { config: { access: "runs.read" } }, async (req, reply) => {
      const snapshot = await getSnapshotDetails(db, id.parse(req.params).id);
      if (!snapshot || !(await ownPipeline(req, snapshot.pipelineId))) return reply.code(404).send({ error: "Snapshot not found" });
      return snapshot;
    });
  };
}
