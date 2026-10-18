import {
  getPipeline,
  getSchedule,
  getSnapshot,
  getSnapshotDetails,
  getTenant,
  previousSucceededSnapshotId,
  saveSnapshotAlert,
  watcherEmails,
  type Db,
} from "@ystara/db";
import {
  alertReasons,
  alertSubject,
  DEFAULT_ROW_DROP_PERCENT,
  describeAlertReason,
  describeRun,
  type AlertReason,
  type SnapshotAlert,
  type SnapshotDetails,
} from "@ystara/shared";

/** One email to a pipeline's watchers, all in Bcc so they don't see each other's addresses. Plain text. */
export interface AlertMail {
  bcc: string[];
  subject: string;
  text: string;
}

export type SendMail = (mail: AlertMail) => Promise<void>;

/**
 * The alert job, after a scheduled snapshot has finished: compares it with the
 * pipeline's previous successful snapshot (alertReasons in @ystara/shared) and,
 * when that calls for an alert, records it and emails the watchers who are
 * members of the pipeline's account. `send` is null when no mail server is set
 * (SMTP_URL): the alert is then only recorded, and shown on the snapshot page.
 * `appUrl`: where the web app is, for the links in the email.
 *
 * Runs again safely: an alert that was sent, or had nobody to go to, is kept as
 * it is. A send that fails is recorded and thrown, so pg-boss tries again.
 */
export async function runSnapshotAlert(db: Db, snapshotId: string, opts: { send: SendMail | null; appUrl: string }): Promise<SnapshotAlert | undefined> {
  const current = await getSnapshotDetails(db, snapshotId);
  if (!current || !current.scheduled || current.status === "queued" || current.status === "running") return undefined;
  if (current.alert && ["sent", "no_watchers", "no_mail_server"].includes(current.alert.status)) return current.alert;
  const pipeline = await getPipeline(db, current.pipelineId);
  const tenant = pipeline && (await getTenant(db, pipeline.tenantId));
  if (!pipeline || !tenant) return undefined;

  const previousId = await previousSucceededSnapshotId(db, pipeline.id, current.requestedAt);
  const previous = previousId ? await getSnapshotDetails(db, previousId) : undefined;
  const schedule = await getSchedule(db, pipeline.id);
  const reasons = alertReasons({ previous, current, output: pipeline.output, rowDropPercent: schedule?.rowDropPercent ?? DEFAULT_ROW_DROP_PERCENT });
  if (!reasons.length) return undefined;

  const alert = { reasons, comparedWith: previous?.id ?? null };
  const recipients = await watcherEmails(db, pipeline.id);
  if (!recipients.length) await saveSnapshotAlert(db, snapshotId, { ...alert, status: "no_watchers" });
  else if (!opts.send) await saveSnapshotAlert(db, snapshotId, { ...alert, status: "no_mail_server" });
  else {
    await saveSnapshotAlert(db, snapshotId, { ...alert, status: "sending" });
    const mail = alertEmail({ pipeline: { id: pipeline.id, name: pipeline.name }, tenantName: tenant.name, current, previous, timeZone: schedule?.timeZone, reasons, appUrl: opts.appUrl });
    try {
      await opts.send({ ...mail, bcc: recipients });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
      await saveSnapshotAlert(db, snapshotId, { ...alert, status: "failed", error });
      throw e;
    }
    await saveSnapshotAlert(db, snapshotId, { ...alert, status: "sent", recipients: recipients.length });
  }
  return (await getSnapshot(db, snapshotId))?.alert ?? undefined;
}

/** The email's subject and text: names, counts and links, never a value from the data. */
export function alertEmail(input: {
  pipeline: { id: string; name: string };
  tenantName: string;
  current: SnapshotDetails;
  previous: SnapshotDetails | undefined;
  /** The schedule's, for the times; UTC once the schedule is gone. */
  timeZone: string | undefined;
  reasons: AlertReason[];
  appUrl: string;
}): Omit<AlertMail, "bcc"> {
  const { pipeline, current, previous, reasons } = input;
  const timeZone = input.timeZone ?? "UTC";
  const app = input.appUrl.replace(/\/+$/, "");
  const lines = [
    `The scheduled snapshot of the pipeline "${pipeline.name}" in the tenant "${input.tenantName}", taken ${describeRun(current.requestedAt, timeZone)} (${timeZone} time), needs a look:`,
    "",
    ...reasons.map((r) => `- ${describeAlertReason(r)}`),
    "",
  ];
  if (previous) {
    lines.push(`Compared with the snapshot of ${describeRun(previous.requestedAt, timeZone)}. See what changed:`);
    lines.push(`${app}/pipelines/${pipeline.id}/compare?from=${previous.id}&to=${current.id}`);
  } else {
    lines.push("There is no earlier successful snapshot to compare it with.");
  }
  lines.push("", "The snapshot:", `${app}/snapshots/${current.id}`, "");
  lines.push(`You get this email because you watch this pipeline in Ystara. To stop, click Unwatch on its page: ${app}/pipelines/${pipeline.id}/snapshots`);
  return { subject: alertSubject(pipeline.name, reasons), text: lines.join("\n") };
}
