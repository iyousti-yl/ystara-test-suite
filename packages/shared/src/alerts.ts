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
