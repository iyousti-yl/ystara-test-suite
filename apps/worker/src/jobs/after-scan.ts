import { changedSteps } from "@ystara/connector";
import {
  createScenarioSuite,
  getScan,
  getTenant,
  hasUnfinishedSuite,
  lastScenarioScanId,
  listDatabaseUsers,
  listPipelines,
  listScenarios,
  loadGraph,
  previousSucceededScan,
  type Db,
  type Queryable,
} from "@ystara/db";
import { whyNoScenarioRun, type LineageGraph } from "@ystara/shared";

/** A suite asked for longer ago than this and still unfinished is taken as stuck: it no longer holds back a new one. */
const STUCK_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * After a successful scan of a tenant (by hand or on its schedule): for each
 * saved pipeline that has scenarios, finds the steps whose definition changed
 * since the scan its scenarios last ran on (or, if they never ran, since the
 * tenant's scan before this one), and queues a suite of its scenarios when any
 * did (changedSteps in the connector). Nothing is sent to the tenant here.
 *
 * Skipped: imported scans and tenants without a Datasphere URL (no database to
 * run checks in), tenants without a connected database user, and pipelines
 * whose previous suite is still queued or running. Each suite is created and
 * its job sent (`queueSuite`, on `tx`) in one transaction.
 */
export async function queueSuitesAfterScan(
  db: Db,
  scanId: string,
  queueSuite: (suiteId: string, tx: Queryable) => Promise<void>,
): Promise<{ queued: number; unchanged: number; skipped: number }> {
  const result = { queued: 0, unchanged: 0, skipped: 0 };
  const scan = await getScan(db, scanId);
  if (!scan || scan.status !== "succeeded" || scan.source !== "tenant") return result;
  const tenant = await getTenant(db, scan.tenantId);
  if (!tenant?.host) return result;
  const runnable = !whyNoScenarioRun(await listDatabaseUsers(db, tenant.id), true);

  const graphs = new Map<string, Promise<LineageGraph>>();
  const graphOf = (id: string) => {
    if (!graphs.has(id)) graphs.set(id, loadGraph(db, id));
    return graphs.get(id)!;
  };
  const previous = await previousSucceededScan(db, scan);
  for (const pipeline of await listPipelines(db, tenant.id)) {
    if (!(await listScenarios(db, pipeline.id)).length) continue;
    const baseline = (await lastScenarioScanId(db, pipeline.id)) ?? previous?.id;
    if (baseline === scan.id) {
      result.unchanged++;
      continue;
    }
    const changed = changedSteps(baseline ? await graphOf(baseline) : undefined, await graphOf(scan.id), pipeline);
    if (!changed.length) result.unchanged++;
    else if (!runnable || (await hasUnfinishedSuite(db, pipeline.id, new Date(Date.now() - STUCK_AFTER_MS)))) result.skipped++;
    else {
      await db.transaction(async (tx) => {
        const suite = await createScenarioSuite(tx, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "scan", scanId: scan.id, changed, requestedBy: null });
        await queueSuite(suite.id, tx);
      });
      result.queued++;
    }
  }
  return result;
}
