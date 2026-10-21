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
  /** Queue the snapshots and scans whose schedule has come (every minute; the name is from before scans had schedules). */
  scheduleTick: "snapshot-schedule-tick",
  /** After a scheduled snapshot: compare it with the previous one and email the watchers when it calls for an alert. */
  snapshotAlert: "snapshot-alert",
  /** Compile a pipeline over a scenario's rows and send each check as one SELECT that reads only those rows. */
  scenarioRun: "scenario-run",
  /** Run every scenario of a pipeline, one after the other through one sign-in. */
  scenarioSuite: "scenario-suite",
  /** After a suite a scan queued: email the watchers (and post in Teams) when scenarios broke. */
  scenarioAlert: "scenario-alert",
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
 * Once a minute (pg-boss's own cron): take a snapshot of every pipeline, and
 * scan every tenant, whose schedule has come. No data. A tick that fails is not retried, and one left
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

export interface ScenarioSuiteJobData {
  suiteId: string;
}

/** A suite is one sign-in and the runs of every scenario of a pipeline. No retries: a person runs it again, or the next scan does. */
export const SCENARIO_SUITE_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 2 * 60 * 60 };

export interface ScenarioAlertJobData {
  suiteId: string;
}

/** As for snapshot alerts: a failed email or Teams post is tried again three times; what went out is never sent twice. */
export const SCENARIO_ALERT_QUEUE_OPTIONS = SNAPSHOT_ALERT_QUEUE_OPTIONS;
