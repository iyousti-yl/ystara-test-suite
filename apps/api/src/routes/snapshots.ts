import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createSnapshot, getPipeline, getSnapshotDetails, getTenant, latestSucceededScan, listSnapshots, type Db } from "@ystara/db";
import { JOBS, type SnapshotJobData } from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import type { JobQueue } from "../server.js";
import { computePipeline } from "./discovery.js";

/**
 * Snapshots of saved pipelines (Snapshot in @ystara/shared): taking one
 * ("runs.execute") queues a job, and the worker measures the steps the
 * database users can see. Reading them needs "runs.read" (every role). As
 * everywhere, another account's pipeline or snapshot answers 404.
 */
const id = z.object({ id: z.string().uuid() });

export function snapshotRoutes(db: Db, queue: JobQueue) {
  /** The pipeline, when its tenant belongs to the signed-in account. */
  async function ownPipeline(req: FastifyRequest, pipelineId: string) {
    const pipeline = await getPipeline(db, pipelineId);
    if (!pipeline) return undefined;
    const tenant = await getTenant(db, pipeline.tenantId);
    return tenant?.accountId === signedIn(req).accountId ? pipeline : undefined;
  }

  return async (app: FastifyInstance) => {
    app.get("/pipelines/:id/snapshots", { config: { access: "runs.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      return listSnapshots(db, pipeline.id);
    });

    // Take a snapshot now. Refused when none of the steps can be measured: the pipeline page says why for each one.
    app.post("/pipelines/:id/snapshots", { config: { access: "runs.execute" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      const scan = await latestSucceededScan(db, pipeline.tenantId);
      if (!scan) return reply.code(409).send({ error: "This tenant has no successful scan yet" });
      const computed = await computePipeline(db, scan, pipeline.output, pipeline.excludeWriters);
      if (!computed) return reply.code(409).send({ error: `${pipeline.output.space}.${pipeline.output.technicalName} is not in the latest scan` });
      if (!Object.values(computed.measurement).some((m) => m.measurable)) {
        return reply.code(409).send({ error: "None of this pipeline's steps can be measured with SQL yet. Its page says why for each step." });
      }
      const snapshot = await createSnapshot(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: signedIn(req).userId });
      await queue.send(JOBS.snapshot, { snapshotId: snapshot.id } satisfies SnapshotJobData);
      return reply.code(202).send(snapshot);
    });

    app.get("/snapshots/:id", { config: { access: "runs.read" } }, async (req, reply) => {
      const snapshot = await getSnapshotDetails(db, id.parse(req.params).id);
      if (!snapshot || !(await ownPipeline(req, snapshot.pipelineId))) return reply.code(404).send({ error: "Snapshot not found" });
      return snapshot;
    });
  };
}
