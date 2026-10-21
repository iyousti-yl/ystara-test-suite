import {
  createScan,
  createSnapshot,
  getConnection,
  getPipeline,
  getTenant,
  hasUnfinishedScan,
  hasUnfinishedSnapshot,
  lockDueScanSchedules,
  lockDueSchedules,
  setNextRun,
  setNextScanRun,
  type Db,
  type Queryable,
} from "@ystara/db";
import { nextRun, readableSpaces } from "@ystara/shared";

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

/** A scan asked for longer ago than this and still unfinished is taken as stuck (a scan job expires after 4 hours). */
const SCAN_STUCK_AFTER_MS = 5 * 60 * 60 * 1000;

/**
 * The same, for scan schedules (migration 013): for each tenant whose scan
 * schedule has come, queues a scan (marked scheduled) of the spaces its
 * technical client could read at its last check, and moves the schedule on.
 * Skipped: a tenant without a Datasphere URL or a connected technical client
 * with a readable space, and one whose previous scan is still queued or
 * running. One transaction, the scan jobs included (`queueScan` sends on `tx`).
 */
export async function runScanScheduleTick(
  db: Db,
  now: Date,
  queueScan: (scanId: string, tx: Queryable) => Promise<void>,
): Promise<{ queued: number; skipped: number }> {
  return db.transaction(async (tx) => {
    let queued = 0;
    let skipped = 0;
    for (const schedule of await lockDueScanSchedules(tx, now)) {
      await setNextScanRun(tx, schedule.tenantId, nextRun(schedule.cron, schedule.timeZone, now));
      const tenant = await getTenant(tx, schedule.tenantId);
      const connection = tenant?.host ? await getConnection(tx, tenant.id) : undefined;
      const spaces = connection ? readableSpaces(connection) : [];
      if (!tenant || !spaces.length || (await hasUnfinishedScan(tx, tenant.id, new Date(now.getTime() - SCAN_STUCK_AFTER_MS)))) {
        skipped++;
        continue;
      }
      const scan = await createScan(tx, tenant.id, spaces, "tenant", { scheduled: true });
      await queueScan(scan.id, tx);
      queued++;
    }
    return { queued, skipped };
  });
}
