/**
 * Background jobs the API enqueues and the worker runs (pg-boss queues on Postgres).
 * The names and payloads live here so both sides agree.
 */
export const JOBS = {
  /** Read the spaces of a scan from its tenant (list and read only) and store the lineage graph. */
  scan: "discovery-scan",
  /** Log in to a tenant with its technical client and list the spaces it can see. */
  connectionCheck: "connection-check",
} as const;

export interface ScanJobData {
  scanId: string;
}

/** Queue settings for scans: a large space can take a while, and failures need a person, so no retries. */
export const SCAN_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 4 * 60 * 60 };

export interface ConnectionCheckJobData {
  tenantId: string;
}

/** A check is a login and one list: if it hangs, the person retries with "Check again". */
export const CONNECTION_CHECK_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 5 * 60 };
