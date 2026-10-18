import { createSnapshot, getPipeline, getTenant, hasUnfinishedSnapshot, lockDueSchedules, setNextRun, type Db, type Queryable } from "@ystara/db";
import { nextRun } from "@ystara/shared";

/** A snapshot asked for longer ago than this and still unfinished is taken as stuck: it no longer holds back the schedule. */
const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Runs once a minute: for each pipeline whose schedule has come, queues a
 * snapshot (marked scheduled) and moves the schedule's next run to the first
 * one after `now`. A missed run (the worker was stopped) is taken once, not
 * once per missed run. A run is skipped when the previous snapshot of the
 * pipeline is still queued or running, and on a tenant made from imported
 * scans, which has no database to measure (the API refuses such a schedule;
 * the demo tenant of `npm run db:demo` has one to show). Everything happens in one transaction,
 * the job included (`queueSnapshot` sends it on `tx`), so a crash leaves
 * neither a snapshot without its job nor a run taken twice.
 */
export async function runScheduleTick(
  db: Db,
  now: Date,
  queueSnapshot: (snapshotId: string, tx: Queryable) => Promise<void>,
): Promise<{ queued: number; skipped: number }> {
  return db.transaction(async (tx) => {
    let queued = 0;
    let skipped = 0;
    for (const schedule of await lockDueSchedules(tx, now)) {
      await setNextRun(tx, schedule.pipelineId, nextRun(schedule.cron, schedule.timeZone, now));
      const pipeline = await getPipeline(tx, schedule.pipelineId);
      const tenant = pipeline && (await getTenant(tx, pipeline.tenantId));
      if (!pipeline || !tenant?.host || (await hasUnfinishedSnapshot(tx, pipeline.id, new Date(now.getTime() - STUCK_AFTER_MS)))) {
        skipped++;
        continue;
      }
      const snapshot = await createSnapshot(tx, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: null, scheduled: true, requestedAt: now });
      await queueSnapshot(snapshot.id, tx);
      queued++;
    }
    return { queued, skipped };
  });
}
