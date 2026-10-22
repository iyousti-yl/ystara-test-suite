import { describeAlertReason, type AlertReason } from "./alerts.js";
import type { ScenarioRunStatus, ScenarioSuiteCause, SignOffVerdict, SnapshotStatus } from "./api.js";

/**
 * A pipeline's health in one word, for the Pipelines board and the pipeline's
 * header: what its latest run of all scenarios and its latest snapshot say,
 * most pressing first, in one sentence with the next thing to do. Worked out
 * from stored results only (GET /api/tenants/:id/pipeline-summaries); nothing
 * calls the tenant.
 */
export interface PipelineSummary {
  pipelineId: string;
  /** How many scenarios the pipeline has. */
  scenarios: number;
  /** Its latest run of all scenarios. */
  suite: {
    id: string;
    cause: ScenarioSuiteCause;
    status: ScenarioRunStatus;
    requestedAt: Date;
    finishedAt: Date | null;
    passed: number | null;
    total: number | null;
  } | null;
  /** Its latest snapshot, with the output's rows and the reasons of the alert it raised, if any. */
  snapshot: {
    id: string;
    status: SnapshotStatus;
    scheduled: boolean;
    requestedAt: Date;
    finishedAt: Date | null;
    outputRows: number | null;
    alert: AlertReason[] | null;
  } | null;
  schedule: { cron: string; timeZone: string; nextRunAt: Date } | null;
  /** Its latest sign-off; `outdated` when it approved and a later scan has changed a step since. */
  signOff: { verdict: SignOffVerdict; signedAt: Date; outdated: boolean } | null;
  /** Whether the signed-in user watches it. */
  watching: boolean;
}

/** Most pressing first: the board sorts on this order. */
export const HEALTH_STATES = ["failing", "changed", "untested", "running", "ok"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_LABEL: Record<HealthState, string> = {
  failing: "Failing",
  changed: "Changed",
  untested: "Not tested yet",
  running: "Running",
  ok: "OK",
};

/** Where the next step leads, as a page of the app. */
export type HealthNext =
  | { page: "suite"; id: string; text: string }
  | { page: "snapshot"; id: string; text: string }
  | { page: "compare"; text: string }
  | { page: "scenarios"; text: string }
  | { page: "snapshots"; text: string };

export interface PipelineHealth {
  state: HealthState;
  /** What the latest results say, in one sentence. */
  sentence: string;
  next: HealthNext | null;
}

export function pipelineHealth(s: Pick<PipelineSummary, "scenarios" | "suite" | "snapshot">): PipelineHealth {
  const { suite, snapshot } = s;
  if (suite && (suite.status === "failed" || suite.status === "error")) {
    const failing = (suite.total ?? 0) - (suite.passed ?? 0);
    return {
      state: "failing",
      sentence:
        suite.status === "error" || !suite.total
          ? "The latest run of all scenarios couldn't run."
          : `${suite.total === 1 ? "Its one scenario fails" : `${failing} of ${suite.total} scenarios ${failing === 1 ? "fails" : "fail"}`}${suite.cause === "scan" ? " after a scan changed the pipeline" : ""}.`,
      next: { page: "suite", id: suite.id, text: "See which checks broke" },
    };
  }
  if (snapshot?.status === "failed") {
    return { state: "failing", sentence: "The latest snapshot failed.", next: { page: "snapshot", id: snapshot.id, text: "Open the snapshot" } };
  }
  if (snapshot?.alert?.length) {
    return { state: "changed", sentence: describeAlertReason(snapshot.alert[0]), next: { page: "compare", text: "Compare the latest snapshots" } };
  }
  const running = suite?.status === "queued" || suite?.status === "running" || snapshot?.status === "queued" || snapshot?.status === "running";
  if (running) return { state: "running", sentence: suite?.status === "queued" || suite?.status === "running" ? "Its scenarios are running." : "A snapshot is being taken.", next: null };
  if (suite?.status === "passed") {
    const sentence = suite.total === 1 ? "Its one scenario passes." : suite.total === 2 ? "Both its scenarios pass." : `All ${suite.total ?? 0} scenarios pass.`;
    return { state: "ok", sentence, next: null };
  }
  if (snapshot?.status === "succeeded") {
    return {
      state: "ok",
      sentence: s.scenarios ? "The latest snapshot raised nothing; its scenarios haven't all run together yet." : "The latest snapshot raised nothing. No scenario tests its logic yet.",
      next: s.scenarios ? null : { page: "scenarios", text: "Write a scenario" },
    };
  }
  return {
    state: "untested",
    sentence:
      s.scenarios === 1 ? "Its one scenario hasn't run with Run all yet." : s.scenarios ? `${s.scenarios} scenarios, never run all together.` : "No scenario or snapshot yet.",
    next: s.scenarios ? { page: "scenarios", text: "Run all scenarios" } : { page: "scenarios", text: "Write a scenario" },
  };
}
