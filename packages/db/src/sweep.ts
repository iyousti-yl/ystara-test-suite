import { JOBS } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Rows a job was working on when its worker stopped (a deploy, a crash, a
 * restore) stay "running" or "queued" with nothing behind them, and the app
 * shows them as busy for good. The worker sweeps them at start and with every
 * minute tick: a row whose job pg-boss no longer holds (it finished, failed or
 * was failed by pg-boss's own shutdown) is marked as interrupted, with a
 * sentence saying what to do. A row saved less than two minutes ago is left
 * alone, in case its job is being sent at that moment.
 */

/** The ids pg-boss still holds a job for (waiting, to be retried or running), per kind of row. */
export interface LiveJobs {
  scans: Set<string>;
  snapshots: Set<string>;
  suites: Set<string>;
  runs: Set<string>;
  /** Tenant ids with a connection check. */
  connectionChecks: Set<string>;
  /** "tenantId space" with a database user check. */
  databaseChecks: Set<string>;
}

export interface SweepResult {
  scans: number;
  snapshots: number;
  suites: number;
  runs: number;
  connections: number;
  databaseUsers: number;
}

const GRACE = "2 minutes";
const AGAIN = "Ystara restarted while it ran. Start it again.";

/** What pg-boss still holds, read from its own job table (the worker passes this to sweepInterrupted). */
export async function liveJobs(db: Queryable): Promise<LiveJobs> {
  const { rows } = await db.query<{ name: string; data: Record<string, string> }>(
    "select name, data from pgboss.job where state in ('created', 'retry', 'active') and name = any($1)",
    [[JOBS.scan, JOBS.snapshot, JOBS.scenarioSuite, JOBS.scenarioRun, JOBS.connectionCheck, JOBS.databaseCheck]],
  );
  const live: LiveJobs = { scans: new Set(), snapshots: new Set(), suites: new Set(), runs: new Set(), connectionChecks: new Set(), databaseChecks: new Set() };
  for (const { name, data } of rows) {
    if (name === JOBS.scan) live.scans.add(data.scanId);
    else if (name === JOBS.snapshot) live.snapshots.add(data.snapshotId);
    else if (name === JOBS.scenarioSuite) live.suites.add(data.suiteId);
    else if (name === JOBS.scenarioRun) live.runs.add(data.runId);
    else if (name === JOBS.connectionCheck) live.connectionChecks.add(data.tenantId);
    else if (name === JOBS.databaseCheck) live.databaseChecks.add(`${data.tenantId} ${data.space}`);
  }
  return live;
}

/** Marks the rows no job holds any more as interrupted, and says how many of each. */
export async function sweepInterrupted(db: Queryable, live: LiveJobs): Promise<SweepResult> {
  const count = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows.length;
  const scans = await count(
    `update scans set status = 'failed', finished_at = now(), error = $2
     where status in ('queued', 'running') and requested_at < now() - interval '${GRACE}' and not (id::text = any($1))
     returning id`,
    [[...live.scans], `The scan stopped: ${AGAIN}`],
  );
  const snapshots = await count(
    `update snapshots set status = 'failed', finished_at = now(), error = $2
     where status in ('queued', 'running') and requested_at < now() - interval '${GRACE}' and not (id::text = any($1))
     returning id`,
    [[...live.snapshots], `The snapshot stopped: ${AGAIN}`],
  );
  // A suite's runs have no job of their own: they go with their suite.
  const suites = await db.query<{ id: string }>(
    `update scenario_suites set status = 'error', finished_at = now(), error = $2
     where status in ('queued', 'running') and requested_at < now() - interval '${GRACE}' and not (id::text = any($1))
     returning id`,
    [[...live.suites], `The run of all scenarios stopped: ${AGAIN}`],
  );
  const runs = await count(
    `update scenario_runs set status = 'error', finished_at = now(), error = $3
     where status in ('queued', 'running') and requested_at < now() - interval '${GRACE}'
       and (case when suite_id is null then not (id::text = any($1)) else suite_id::text = any($2) end)
     returning id`,
    [[...live.runs], suites.rows.map((s) => s.id), `The run stopped: ${AGAIN}`],
  );
  const connections = await count(
    `update tenant_connections set status = 'failed', checked_at = now(), error = $2
     where status = 'checking' and updated_at < now() - interval '${GRACE}' and not (tenant_id::text = any($1))
     returning tenant_id`,
    [[...live.connectionChecks], `The check stopped: ${AGAIN.replace("Start it", "Check")}`],
  );
  const databaseUsers = await count(
    `update space_database_users set status = 'failed', checked_at = now(), error = $2
     where status = 'checking' and updated_at < now() - interval '${GRACE}' and not ((tenant_id::text || ' ' || space) = any($1))
     returning tenant_id`,
    [[...live.databaseChecks], `The check stopped: ${AGAIN.replace("Start it", "Check")}`],
  );
  return { scans, snapshots, suites: suites.rows.length, runs, connections, databaseUsers };
}
