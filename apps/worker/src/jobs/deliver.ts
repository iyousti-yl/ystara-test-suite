import type { AlertStatus, PostToTeams, TeamsDelivery, TeamsMessage } from "@ystara/shared";

/** One email to a pipeline's watchers, all in Bcc so they don't see each other's addresses. Plain text. */
export interface AlertMail {
  bcc: string[];
  subject: string;
  text: string;
}

export type SendMail = (mail: AlertMail) => Promise<void>;

/**
 * Where alerts go. `send` is null when no mail server is set (SMTP_URL): the
 * email part is then only recorded. `appUrl`: where the web app is, for the
 * links. `teams`: the account's Teams channel, if it has one (its webhook
 * address, opened from the database), and how to post there.
 */
export interface AlertDelivery {
  send: SendMail | null;
  appUrl: string;
  teams?: { webhook(accountId: string): Promise<string | undefined>; post: PostToTeams };
}

/**
 * Sends one alert, by email to the pipeline's watchers and in the account's
 * Teams channel, each unless an earlier try already settled it, and records
 * how each went. Both are tried before the first failure is thrown, so
 * pg-boss tries again for what failed only.
 */
export async function deliverAlert(
  alert: {
    accountId: string;
    /** The email went out, or had nobody to go to, on an earlier try. */
    emailSettled: boolean;
    /** The Teams post went out on an earlier try. */
    teamsSent: boolean;
    recipients(): Promise<string[]>;
    mail(): Omit<AlertMail, "bcc">;
    teamsMessage(): TeamsMessage;
    save(status: AlertStatus, extra?: { recipients?: number; error?: string }): Promise<void>;
    saveTeams(delivery: TeamsDelivery | null): Promise<void>;
  },
  to: AlertDelivery,
): Promise<void> {
  let failure: unknown;
  if (!alert.emailSettled) {
    const recipients = await alert.recipients();
    if (!recipients.length) await alert.save("no_watchers");
    else if (!to.send) await alert.save("no_mail_server");
    else {
      await alert.save("sending");
      try {
        await to.send({ ...alert.mail(), bcc: recipients });
        await alert.save("sent", { recipients: recipients.length });
      } catch (e) {
        await alert.save("failed", { error: firstLine(e) });
        failure = e;
      }
    }
  }
  if (!alert.teamsSent) {
    const webhook = to.teams && (await to.teams.webhook(alert.accountId));
    if (!to.teams || !webhook) await alert.saveTeams(null);
    else {
      await alert.saveTeams({ status: "sending", error: null });
      try {
        await to.teams.post(webhook, alert.teamsMessage());
        await alert.saveTeams({ status: "sent", error: null });
      } catch (e) {
        await alert.saveTeams({ status: "failed", error: firstLine(e) });
        failure ??= e;
      }
    }
  }
  if (failure) throw failure;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
