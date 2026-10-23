import {
  getPipeline,
  getSchedule,
  getSnapshot,
  getSnapshotDetails,
  getTenant,
  previousSucceededSnapshotId,
  saveSnapshotAlert,
  saveSnapshotAlertTeams,
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
  type TeamsMessage,
} from "@ystara/shared";
import { deliverAlert, type AlertDelivery, type AlertMail } from "./deliver.js";

export type { AlertMail, SendMail } from "./deliver.js";

/**
 * The alert job, after a scheduled snapshot has finished: compares it with the
 * pipeline's previous successful snapshot (alertReasons in @ystara/shared) and,
 * when that calls for an alert, records it, emails the watchers who are
 * members of the pipeline's account, and posts it in the account's Teams
 * channel when it has one (deliverAlert). Without a mail server (SMTP_URL) the
 * email part is only recorded; the alert shows on the snapshot page either way.
 *
 * Runs again safely: what went out (or had nobody to go to) is kept as it is.
 * A send or post that fails is recorded and thrown, so pg-boss tries again.
 */
export async function runSnapshotAlert(db: Db, snapshotId: string, opts: AlertDelivery): Promise<SnapshotAlert | undefined> {
  const current = await getSnapshotDetails(db, snapshotId);
  if (!current || !current.scheduled || current.status === "queued" || current.status === "running") return undefined;
  const emailSettled = !!current.alert && ["sent", "no_watchers", "no_mail_server"].includes(current.alert.status);
  const teamsSent = current.alert?.teams?.status === "sent";
  if (emailSettled && teamsSent) return current.alert ?? undefined;
  const pipeline = await getPipeline(db, current.pipelineId);
  const tenant = pipeline && (await getTenant(db, pipeline.tenantId));
  if (!pipeline || !tenant) return undefined;

  const previousId = await previousSucceededSnapshotId(db, pipeline.id, current.requestedAt);
  const previous = previousId ? await getSnapshotDetails(db, previousId) : undefined;
  const schedule = await getSchedule(db, pipeline.id);
  const reasons = current.alert?.reasons ?? alertReasons({ previous, current, output: pipeline.output, rowDropPercent: schedule?.rowDropPercent ?? DEFAULT_ROW_DROP_PERCENT });
  if (!reasons.length) return undefined;

  const comparedWith = current.alert ? current.alert.comparedWith : (previous?.id ?? null);
  const message = { pipeline: { id: pipeline.id, name: pipeline.name }, tenantName: tenant.name, current, previous, timeZone: schedule?.timeZone, reasons, appUrl: opts.appUrl };
  await deliverAlert(
    {
      accountId: tenant.accountId,
      emailSettled,
      teamsSent,
      recipients: () => watcherEmails(db, pipeline.id),
      mail: () => alertEmail(message),
      teamsMessage: () => alertTeamsMessage(message),
      save: (status, extra) => saveSnapshotAlert(db, snapshotId, { reasons, comparedWith, status, ...extra }),
      saveTeams: (delivery) => saveSnapshotAlertTeams(db, snapshotId, delivery),
    },
    opts,
  );
  return (await getSnapshot(db, snapshotId))?.alert ?? undefined;
}

interface AlertContent {
  pipeline: { id: string; name: string };
  tenantName: string;
  current: SnapshotDetails;
  previous: SnapshotDetails | undefined;
  /** The schedule's, for the times; UTC once the schedule is gone. */
  timeZone: string | undefined;
  reasons: AlertReason[];
  appUrl: string;
}

/** The email's subject and text: names, counts and links, never a value from the data. */
export function alertEmail(input: AlertContent): Omit<AlertMail, "bcc"> {
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
  lines.push(`You get this email because you watch this pipeline in Ystara. To stop, open the pipeline and click Watching at the top: ${app}/pipelines/${pipeline.id}`);
  return { subject: alertSubject(pipeline.name, reasons), text: lines.join("\n") };
}

/** The same alert as a Teams card: the reasons, and a link to what changed (or to the snapshot). */
export function alertTeamsMessage(input: AlertContent): TeamsMessage {
  const { pipeline, current, previous, reasons } = input;
  const timeZone = input.timeZone ?? "UTC";
  const app = input.appUrl.replace(/\/+$/, "");
  return {
    title: alertSubject(pipeline.name, reasons).replace(/^\[Ystara\] /, ""),
    subtitle: `Tenant ${input.tenantName} · scheduled snapshot of ${describeRun(current.requestedAt, timeZone)} (${timeZone})`,
    lines: reasons.map(describeAlertReason),
    link: previous
      ? { title: "See what changed", url: `${app}/pipelines/${pipeline.id}/compare?from=${previous.id}&to=${current.id}` }
      : { title: "Open the snapshot", url: `${app}/snapshots/${current.id}` },
  };
}
