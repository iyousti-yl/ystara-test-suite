import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

/**
 * The mail server's settings from SMTP_URL (smtp://user:password@host:587, or smtps:// on port 465).
 *
 * On smtp:// the connection must switch to TLS (STARTTLS) before the password and the alerts are sent: without
 * requireTLS, nodemailer sends both in the clear when the server, or someone between, doesn't offer it. Only a
 * server on this machine or inside the Docker network (a name without a dot, such as mailpit) may go without.
 * Every wait has a limit, so an alert job never hangs on a silent server (pg-boss tries the job again).
 */
export function mailTransport(smtpUrl: string): SMTPTransport.Options {
  const url = new URL(smtpUrl);
  const secure = url.protocol === "smtps:";
  if (!secure && url.protocol !== "smtp:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
  return {
    host,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: !secure && !local,
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  };
}
