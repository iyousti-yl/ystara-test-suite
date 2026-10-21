import type { AlertStatus, Json, TeamsDelivery } from "@ystara/shared";
import { counted, formatDateTime } from "./format";

/** Whether an alert reached the pipeline's watchers by email, as a sentence. */
export function emailDelivery(alert: { status: AlertStatus; recipients: number; error: string | null; sentAt: string | null }): string {
  switch (alert.status) {
    case "sent":
      return `Emailed to ${counted(alert.recipients, "watcher")} on ${formatDateTime(alert.sentAt)}.`;
    case "sending":
      return "The email is being sent.";
    case "failed":
      return `The email could not be sent (${alert.error ?? "no reason given"}). The worker tries again a few times.`;
    case "no_watchers":
      return "Nobody watches this pipeline, so no email went out.";
    case "no_mail_server":
      return "No email went out: this Ystara has no mail server yet.";
  }
}

/** And whether it was posted in the account's Teams channel; empty when the account has none. */
export function teamsDelivery(teams: Json<TeamsDelivery> | null): string {
  if (!teams) return "";
  if (teams.status === "sent") return "Posted in the Teams channel.";
  if (teams.status === "sending") return "It is being posted in the Teams channel.";
  return `Posting in the Teams channel failed (${teams.error ?? "no reason given"}). The worker tries again a few times.`;
}
