/**
 * Background jobs the API enqueues and the worker runs (pg-boss queues on Postgres).
 * The names and payloads live here so both sides agree.
 */
export const JOBS = {
  /** Read the spaces of a scan from its tenant (list and read only) and store the lineage graph. */
  scan: "discovery-scan",
  /** Log in to a tenant with its technical client and check which of its spaces it can read. */
  connectionCheck: "connection-check",
  /** Sign in with a space's database user and list what it can read there (SELECT only). */
  databaseCheck: "database-check",
  /** Measure the steps of a pipeline with SQL (SELECT only) and store the measures, never rows. */
  snapshot: "snapshot-capture",
  /** Queue the snapshots whose pipeline schedule has come (every minute). */
  scheduleTick: "snapshot-schedule-tick",
  /** After a scheduled snapshot: compare it with the previous one and email the watchers when it calls for an alert. */
  snapshotAlert: "snapshot-alert",
  /** Compile a pipeline over a scenario's rows and send each check as one SELECT that reads only those rows. */
  scenarioRun: "scenario-run",
} as const;

export interface ScanJobData {
  scanId: string;
}

/** Queue settings for scans: a large space can take a while, and failures need a person, so no retries. */
export const SCAN_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 4 * 60 * 60 };

export interface ConnectionCheckJobData {
  tenantId: string;
}

/** A check is a login and two one-object lists per space: if it hangs, the person retries with "Check again". */
export const CONNECTION_CHECK_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 5 * 60 };

export interface DatabaseCheckJobData {
  tenantId: string;
  space: string;
}

/**
 * One sign-in and three short SELECTs. No retries: a wrong password signed in
 * again and again can lock the user, so another try waits for "Check again".
 */
export const DATABASE_CHECK_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 5 * 60 };

export interface SnapshotJobData {
  snapshotId: string;
}

/** A snapshot reads every measurable step of a pipeline once; large views take a while. No retries: a person starts it again. */
export const SNAPSHOT_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 60 * 60 };

/**
 * Once a minute (pg-boss's own cron): take a snapshot of every pipeline whose
 * schedule has come. No data. A tick that fails is not retried, and one left
 * waiting more than 5 minutes is dropped: the next tick finds the same
 * schedules still due.
 */
export const SCHEDULE_TICK_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 5 * 60, retentionMinutes: 5 };

export interface SnapshotAlertJobData {
  snapshotId: string;
}

/**
 * Comparing two stored snapshots takes a moment; sending can meet a mail server
 * that is briefly down, so a failed send is tried again three times, a minute
 * apart and then longer. An alert already sent is never sent twice.
 */
export const SNAPSHOT_ALERT_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 5 * 60 };

export interface ScenarioRunJobData {
  runId: string;
}

/** A run is a sign-in and one SELECT per check over the scenario's own rows. No retries: a person runs it again. */
export const SCENARIO_RUN_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 30 * 60 };
