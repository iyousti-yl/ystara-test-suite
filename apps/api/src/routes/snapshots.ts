import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createSnapshot,
  deleteSchedule,
  getSchedule,
  getSnapshotDetails,
  hasUnfinishedSnapshot,
  latestSucceededScan,
  listSnapshots,
  setSchedule,
  unwatchPipeline,
  watchPipeline,
  watchState,
  type Db,
} from "@ystara/db";
import {
  checkSchedule,
  compareSnapshots,
  JOBS,
  SNAPSHOT_QUEUE_OPTIONS,
  whyNothingMeasurable,
  type PipelineDefinition,
  type SnapshotComparison,
  type SnapshotJobData,
  type Tenant,
} from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import { scope } from "../scope.js";
import type { JobQueue } from "../server.js";
import { computePipeline, Page } from "./discovery.js";

/**
 * Snapshots of saved pipelines (Snapshot in @ystara/shared): taking one
 * ("runs.execute") queues a job, and the worker measures the steps the
 * database users can see. Reading them, and comparing two of them, needs
 * "runs.read" (every role). As everywhere, another account's pipeline or
 * snapshot answers 404.
 *
 * A pipeline can also have a schedule (a cron line in a time zone, checked by
 * checkSchedule in @ystara/shared): the worker then takes its snapshots on its
 * own. Setting or removing one needs "runs.execute", like taking a snapshot.
 * Everyone in the account can watch a pipeline, to get an email when one of
 * its scheduled snapshots calls for an alert (alerts.ts in @ystara/shared).
 */
const id = z.object({ id: z.string().uuid() });
const ScheduleBody = z.object({ cron: z.string().max(200), timeZone: z.string().max(100), rowDropPercent: z.number().int().min(1).max(100).optional() });
const ComparePair = z
  .object({ from: z.string().uuid().optional(), to: z.string().uuid().optional() })
  .refine((q) => (q.from === undefined) === (q.to === undefined), "Give both from and to, or neither for the latest two snapshots");

export function snapshotRoutes(db: Db, queue: JobQueue) {
  // The pipeline (and its tenant), when the signed-in user may reach it (scope.ts).
  const { pipeline: ownPipeline, pipelineAndTenant: ownPipelineAndTenant } = scope(db);

  /** Why no snapshot of the pipeline could measure anything today, or undefined when at least one step can be measured. */
  async function whyNoSnapshot({ pipeline, tenant }: { pipeline: PipelineDefinition; tenant: Tenant }): Promise<string | undefined> {
    const scan = await latestSucceededScan(db, pipeline.tenantId);
    if (!scan) return "This tenant has no successful scan yet";
    const computed = await computePipeline(db, scan, pipeline.output, pipeline.excludeWriters);
    if (!computed) return `${pipeline.output.space}.${pipeline.output.technicalName} is not in the latest scan`;
    if (!Object.values(computed.measurement).some((m) => m.measurable)) return whyNothingMeasurable(computed.pipeline.steps, computed.measurement, tenant.host !== null);
    return undefined;
  }

  return async (app: FastifyInstance) => {
    app.get("/pipelines/:id/snapshots", { config: { access: "runs.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      return listSnapshots(db, pipeline.id, Page.parse(req.query));
    });

    // Take a snapshot now. Refused when none of the steps can be measured, saying what would change that.
    app.post("/pipelines/:id/snapshots", { config: { access: "runs.execute" } }, async (req, reply) => {
      const own = await ownPipelineAndTenant(req, id.parse(req.params).id);
      if (!own) return reply.code(404).send({ error: "Pipeline not found" });
      const { pipeline } = own;
      const why = await whyNoSnapshot(own);
      if (why) return reply.code(409).send({ error: why });
      // One at a time per pipeline (one older than the snapshot queue's time limit is stuck, and the worker's sweep ends it).
      if (await hasUnfinishedSnapshot(db, pipeline.id, new Date(Date.now() - SNAPSHOT_QUEUE_OPTIONS.expireInSeconds * 1000))) {
        return reply.code(409).send({ error: "A snapshot of this pipeline is still being taken. Take the next one once it has finished." });
      }
      const snapshot = await db.transaction(async (tx) => {
        const created = await createSnapshot(tx, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: signedIn(req).userId });
        await queue.send(JOBS.snapshot, { snapshotId: created.id } satisfies SnapshotJobData, tx);
        return created;
      });
      return reply.code(202).send(snapshot);
    });

    // The pipeline's schedule, or null when its snapshots are only taken by hand.
    app.get("/pipelines/:id/schedule", { config: { access: "runs.read" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      return { schedule: (await getSchedule(db, pipeline.id)) ?? null };
    });

    // Set or replace the schedule. Refused when the cron line doesn't make a schedule (400, saying why),
    // and, like taking a snapshot, when no step can be measured (409).
    app.put("/pipelines/:id/schedule", { config: { access: "runs.execute" } }, async (req, reply) => {
      const own = await ownPipelineAndTenant(req, id.parse(req.params).id);
      if (!own) return reply.code(404).send({ error: "Pipeline not found" });
      const body = ScheduleBody.parse(req.body);
      const check = checkSchedule(body.cron, body.timeZone);
      if (!check.ok) return reply.code(400).send({ error: check.error });
      const why = await whyNoSnapshot(own);
      if (why) return reply.code(409).send({ error: why });
      const schedule = await setSchedule(db, {
        pipelineId: own.pipeline.id,
        cron: check.cron,
        timeZone: body.timeZone,
        nextRunAt: check.next[0],
        rowDropPercent: body.rowDropPercent,
        updatedBy: signedIn(req).userId,
      });
      return { schedule };
    });

    app.delete("/pipelines/:id/schedule", { config: { access: "runs.execute" } }, async (req, reply) => {
      const pipeline = await ownPipeline(req, id.parse(req.params).id);
      if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
      await deleteSchedule(db, pipeline.id);
      return reply.code(204).send();
    });

    // Whether the signed-in user watches the pipeline, and how many members of the account do. Watching needs only "runs.read".
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      app.route({
        method,
        url: "/pipelines/:id/watch",
        config: { access: "runs.read" },
        handler: async (req, reply) => {
          const pipeline = await ownPipeline(req, id.parse(req.params).id);
          if (!pipeline) return reply.code(404).send({ error: "Pipeline not found" });
          const { userId, accountId } = signedIn(req);
          if (method === "PUT") await watchPipeline(db, pipeline.id, userId);
          if (method === "DELETE") await unwatchPipeline(db, pipeline.id, userId);
          return watchState(db, pipeline.id, userId, accountId);
        },
      });
    }

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
