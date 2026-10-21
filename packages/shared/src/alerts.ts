import { compareSnapshots } from "./compare.js";
import type { SnapshotDetails } from "./api.js";
import { refKey, type DspObjectRef } from "./objects.js";

/**
 * Alerts on scheduled snapshots (decided by Issam, 2026-10-18): the pipeline's
 * watchers get an email when a scheduled snapshot fails, when a step's
 * definition or columns change, and when the output goes empty or loses more
 * than a set share of its rows (20% unless the schedule says otherwise). Other
 * changes in the data show on the compare page only. Each scheduled snapshot
 * is compared with the pipeline's previous successful one.
 *
 * A reason carries step and column names and row counts, never a value from
 * the data, and never a database error's text: such a message can quote a
 * value. The snapshot page shows the error to those who can sign in.
 */
export type AlertReason =
  /** `steps`: the steps that failed; empty when the snapshot stopped before measuring any. */
  | { kind: "failed"; steps: string[] }
  | { kind: "output_empty"; step: string; rowsBefore: number }
  | { kind: "output_dropped"; step: string; rowsBefore: number; rowsAfter: number; percent: number; threshold: number }
  | { kind: "definition_changed"; steps: string[] }
  | { kind: "columns_changed"; steps: { step: string; added: string[]; removed: string[]; retyped: string[] }[] }
  /** The pipeline itself changed: steps in only one of the two snapshots. */
  | { kind: "steps_changed"; added: string[]; removed: string[] };

export const DEFAULT_ROW_DROP_PERCENT = 20;

/** Whether an alert's email went out, and if not, why. */
export type AlertStatus = "sending" | "sent" | "failed" | "no_watchers" | "no_mail_server";

/**
 * Whether an alert was also posted in the account's Microsoft Teams channel
 * (migration 013); null when the account has no channel, or had none then.
 */
export interface TeamsDelivery {
  status: "sending" | "sent" | "failed";
  /** Why posting failed: what Teams answered, or that it couldn't be reached. */
  error: string | null;
}

/** The alert raised by a scheduled snapshot (migration 009); none when nothing called for one. */
export interface SnapshotAlert {
  reasons: AlertReason[];
  /** The previous successful snapshot it was compared with, if there was one. */
  comparedWith: string | null;
  status: AlertStatus;
  /** How many watchers it was sent to. */
  recipients: number;
  /** Why sending failed (the mail server's answer). */
  error: string | null;
  sentAt: Date | null;
  teams: TeamsDelivery | null;
}

/**
 * Why a finished scheduled snapshot calls for an alert, most pressing first;
 * empty when it doesn't. `previous`: the pipeline's previous successful
 * snapshot, if any. `output`: the pipeline's output, whose rows are watched.
 */
export function alertReasons(input: {
  previous: SnapshotDetails | undefined;
  current: SnapshotDetails;
  output: Pick<DspObjectRef, "space" | "technicalName">;
  rowDropPercent: number;
}): AlertReason[] {
  const { previous, current, output, rowDropPercent } = input;
  const reasons: AlertReason[] = [];
  if (current.status === "failed") {
    reasons.push({ kind: "failed", steps: current.objects.filter((o) => o.status === "failed").map((o) => o.technicalName) });
  }
  if (!previous) return reasons;

  const comparison = compareSnapshots(previous, current);
  const out = comparison.compared.find((o) => refKey(o) === refKey(output));
  if (out && out.rows.before > 0) {
    const { before, after } = out.rows;
    const percent = Math.round(((before - after) / before) * 1000) / 10;
    if (after === 0) reasons.push({ kind: "output_empty", step: out.technicalName, rowsBefore: before });
    else if (percent > rowDropPercent) {
      reasons.push({ kind: "output_dropped", step: out.technicalName, rowsBefore: before, rowsAfter: after, percent, threshold: rowDropPercent });
    }
  }

  const definitions = [...comparison.compared, ...comparison.measuredOnce, ...comparison.definitionsOnly].filter((o) => o.definitionChanged);
  if (definitions.length) reasons.push({ kind: "definition_changed", steps: definitions.map((o) => o.technicalName) });

  const columns = comparison.compared
    .map((o) => ({
      step: o.technicalName,
      added: o.columnsAdded,
      removed: o.columnsRemoved,
      retyped: o.columns.filter((c) => c.dataType.before !== c.dataType.after).map((c) => c.name),
    }))
    .filter((c) => c.added.length || c.removed.length || c.retyped.length);
  if (columns.length) reasons.push({ kind: "columns_changed", steps: columns });

  if (comparison.added.length || comparison.removed.length) {
    reasons.push({ kind: "steps_changed", added: comparison.added.map((o) => o.technicalName), removed: comparison.removed.map((o) => o.technicalName) });
  }
  return reasons;
}

/** A reason as one sentence, for the email and the snapshot page. */
export function describeAlertReason(reason: AlertReason): string {
  const count = (n: number) => n.toLocaleString("en-GB");
  const list = (names: string[]) => names.join(", ");
  switch (reason.kind) {
    case "failed":
      return reason.steps.length ? `The snapshot failed. Failed steps: ${list(reason.steps)}.` : "The snapshot failed before it measured any step.";
    case "output_empty":
      return `The output ${reason.step} is empty. It had ${count(reason.rowsBefore)} rows in the snapshot before.`;
    case "output_dropped":
      return `The output ${reason.step} lost ${reason.percent}% of its rows: ${count(reason.rowsBefore)} before, ${count(reason.rowsAfter)} now. Alerts start above ${reason.threshold}%.`;
    case "definition_changed":
      return reason.steps.length === 1 ? `The definition of ${reason.steps[0]} changed.` : `The definitions of ${list(reason.steps)} changed.`;
    case "columns_changed":
      return reason.steps
        .map(({ step, added, removed, retyped }) => {
          const parts = [added.length && `added ${list(added)}`, removed.length && `removed ${list(removed)}`, retyped.length && `another type for ${list(retyped)}`];
          return `Columns changed in ${step}: ${parts.filter(Boolean).join("; ")}.`;
        })
        .join(" ");
    case "steps_changed": {
      const parts = [reason.added.length && `added ${list(reason.added)}`, reason.removed.length && `removed ${list(reason.removed)}`];
      return `The pipeline's steps changed: ${parts.filter(Boolean).join("; ")}.`;
    }
  }
}

/** A subject line for the most pressing reason. */
export function alertSubject(pipelineName: string, reasons: AlertReason[]): string {
  const first = reasons[0];
  const what: Record<AlertReason["kind"], string> = {
    failed: "Snapshot failed",
    output_empty: "Output empty",
    output_dropped: first?.kind === "output_dropped" ? `Output down ${first.percent}%` : "",
    definition_changed: "Definition changed",
    columns_changed: "Columns changed",
    steps_changed: "Pipeline steps changed",
  };
  return `[Ystara] ${first ? what[first.kind] : "Snapshot"}: ${pipelineName}`;
}

/**
 * Alerts on suites after a scan (decided by Issam, 2026-10-21): when a scan
 * changes a step of a pipeline, its scenarios run again, and the watchers get
 * an email when a scenario that passed its run before fails or can't run now,
 * or one that never ran before doesn't pass. A scenario that was already
 * failing raises no new alert. A suite someone started by hand raises none:
 * they see its result.
 *
 * Only scenario names and check labels: a check's label repeats the scenario's
 * own expected value, typed in by a person, never data read from the tenant.
 */
export interface BrokenScenario {
  scenarioId: string;
  runId: string;
  name: string;
  status: "failed" | "error";
  /** The labels of the checks that didn't pass, as the run prints them (e.g. "row_count = 2"). */
  failedChecks: string[];
}

/** The alert raised by a suite after a scan (migration 013). */
export interface ScenarioAlert {
  broken: BrokenScenario[];
  status: AlertStatus;
  recipients: number;
  error: string | null;
  sentAt: Date | null;
  teams: TeamsDelivery | null;
}

/**
 * The scenarios of a finished suite that broke: those whose run failed or
 * couldn't run while their run before it passed, or that had no run before.
 * `before`: each scenario's latest finished run before the suite, by scenario id.
 */
export function brokenScenarios(
  runs: { id: string; scenarioId: string; scenarioName: string; status: string; checks: { label: string; status: string }[] | null }[],
  before: Map<string, string>,
): BrokenScenario[] {
  return runs
    .filter((r): r is typeof r & { status: "failed" | "error" } => r.status === "failed" || r.status === "error")
    .filter((r) => (before.get(r.scenarioId) ?? "passed") === "passed")
    .map((r) => ({
      scenarioId: r.scenarioId,
      runId: r.id,
      name: r.scenarioName,
      status: r.status,
      failedChecks: (r.checks ?? []).filter((c) => c.status !== "pass").map((c) => c.label),
    }));
}

/** A broken scenario as one sentence, for the email, Teams and the suite page. */
export function describeBrokenScenario(b: BrokenScenario): string {
  if (b.status === "error") return `"${b.name}" couldn't run.`;
  const shown = b.failedChecks.slice(0, 5);
  const more = b.failedChecks.length - shown.length;
  const checks = shown.length ? `: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}` : "";
  return `"${b.name}" failed ${b.failedChecks.length === 1 ? "a check" : `${b.failedChecks.length} checks`}${checks}.`;
}

/** A subject line naming how many scenarios broke. */
export function scenarioAlertSubject(pipelineName: string, broken: BrokenScenario[]): string {
  return `[Ystara] ${broken.length === 1 ? "A scenario broke" : `${broken.length} scenarios broke`}: ${pipelineName}`;
}
