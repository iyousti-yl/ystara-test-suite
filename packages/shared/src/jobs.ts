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
