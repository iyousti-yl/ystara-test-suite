/**
 * Worker entry point. Consumes jobs from Postgres (pg-boss), so there is no
 * separate queue service. Job types arrive per phase:
 *   discovery-scan    (phase 1) read spaces of a tenant into a stored lineage graph
 *   connection-check  (phase 1) log in with a tenant's technical client and check it can read its spaces
 *   database-check    (phase 2) sign in with a space's database user and list what it can read there
 *   snapshot-capture  (phase 2) measure a pipeline's steps with SQL (counts, hashes, sums; never rows)
 *   snapshot-schedule-tick (phase 2) every minute: queue the snapshots and scans whose schedule has come
 *   snapshot-alert    (phase 2) after a scheduled snapshot: compare it with the one before, email the watchers if needed
 *   scenario-run      (phase 3) send a scenario's checks as SELECTs that read only its own rows (and DUMMY)
 *   scenario-suite    (phase 3) run every scenario of a pipeline; queued by "Run all", or after a scan that changed the pipeline
 *   scenario-alert    (phase 3) after a suite a scan queued: email the watchers when scenarios broke
 *
 * Datasphere access: each tenant's technical client for the CLI, and each
 * space's database user for SQL. The worker opens their secrets with
 * MASTER_KEY. A tenant without a client is not scanned, unless this
 * worker runs on a developer's computer with YSTARA_WORKER_MACHINE_LOGIN=1:
 * then it uses the Datasphere CLI's own login there (see tenant-login.ts).
 * Everything stays read-only.
 *
 * Alert emails go through the mail server in SMTP_URL (smtp://user:password@host:587,
 * or smtps:// on port 465; or in the file SMTP_URL_FILE names, as on a server), from
 * SMTP_FROM, with links to YSTARA_PUBLIC_URL. Without
 * SMTP_URL, alerts are only recorded. Docker Compose points it at Mailpit, a local inbox.
 * Alerts are also posted in an account's Microsoft Teams channel when its admin set one
 * (its webhook address is sealed in the database, like the tenants' secrets).
 */
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";
import PgBoss from "pg-boss";
import { checkDatabaseUser } from "@ystara/connector";
import { assertMasterKey, assertYstaraDatabase, connect, databaseUrl, getTeamsWebhook, liveJobs, recordHeartbeat, sweepInterrupted, type Queryable } from "@ystara/db";
import {
  JOBS,
  postToTeams,
  type ConnectionCheckJobData,
  type DatabaseCheckJobData,
  type ScanJobData,
  type ScenarioAlertJobData,
  type ScenarioRunJobData,
  type ScenarioSuiteJobData,
  type SnapshotAlertJobData,
  type SnapshotJobData,
} from "@ystara/shared";
import { appVersion, loadLocalEnv, settingFromEnv } from "@ystara/shared/env";
import { masterKeyFromEnv, secretBox, teamsChannelSecretContext } from "@ystara/shared/secrets";
import { queueSuitesAfterScan } from "./jobs/after-scan.js";
import { runConnectionCheck } from "./jobs/connection-check.js";
import { runDatabaseCheck } from "./jobs/database-check.js";
import { runScan } from "./jobs/scan.js";
import type { AlertDelivery, SendMail } from "./jobs/deliver.js";
import { runScenarioAlert } from "./jobs/scenario-alert.js";
import { runScenarioRun } from "./jobs/scenario-run.js";
import { runScenarioSuite } from "./jobs/scenario-suite.js";
import { runScanScheduleTick, runScheduleTick } from "./jobs/schedule-tick.js";
import { runSnapshotAlert } from "./jobs/snapshot-alert.js";
import { runSnapshot } from "./jobs/snapshot.js";
import { log, reason } from "./log.js";
import { mailTransport } from "./mail.js";
import { checkSpacesWith, removeStaleFolders, tenantAccess, type LoginOptions } from "./tenant-login.js";

loadLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));
const secrets = secretBox(masterKeyFromEnv()); // before anything else, so a missing key stops the start at once
const version = appVersion();
const worker = { worker: `${os.hostname()}:${process.pid}`, version, startedAt: new Date() };
const login: LoginOptions = { bin: process.env.DSP_CLI_BIN, machineLogin: process.env.YSTARA_WORKER_MACHINE_LOGIN === "1" };
const appUrl = process.env.YSTARA_PUBLIC_URL ?? `http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}`;
const smtpUrl = settingFromEnv("SMTP_URL")?.trim();
const mailer = smtpUrl ? createTransport(mailTransport(smtpUrl), { from: process.env.SMTP_FROM ?? "Ystara <ystara@localhost>" }) : undefined;
const send: SendMail | null = mailer ? async (mail) => void (await mailer.sendMail(mail)) : null;

const url = databaseUrl();
// A statement on Ystara's own database may take up to 5 minutes (saving a large scan); none holds a connection longer.
const db = connect(url, { application: "ystara-worker", statementTimeoutMs: 5 * 60_000 });
await assertYstaraDatabase(db); // before pg-boss creates its own tables in someone else's database
await assertMasterKey(db, secrets); // a wrong key would fail every job that opens a tenant's secret
const boss = new PgBoss(url);
boss.on("error", (err) => log.error("queue error", { error: reason(err) }));
/** Sends a job on a transaction: it exists only if what the transaction saves does too. */
const onTx = (tx: Queryable) => ({ db: { executeSql: (text: string, values: unknown[]) => tx.query(text, values) } });
const alerts: AlertDelivery = {
  send,
  appUrl,
  teams: {
    webhook: async (accountId) => {
      const sealed = await getTeamsWebhook(db, accountId);
      return sealed && secrets.open(sealed, teamsChannelSecretContext(accountId));
    },
    post: postToTeams,
  },
};

/**
 * Takes jobs of `queue`, `copies` at a time, so one customer's long scan doesn't hold up everyone else's. pg-boss
 * records a job that throws as failed but says nothing, so the failure is logged here with its queue and job id.
 */
async function work<T extends object>(queue: string, copies: number, handle: (data: T) => Promise<void>) {
  for (let i = 0; i < copies; i++) {
    await boss.work<T>(queue, async ([job]) => {
      try {
        await handle(job.data);
      } catch (e) {
        log.error("job failed", { queue, job: job.id, error: reason(e) });
        throw e;
      }
    });
  }
}

/** A job queued after another finished (alerts, suites after a scan): its failure is logged and doesn't fail the job that finished. */
async function followUp(what: string, fields: Record<string, unknown>, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    log.error(`couldn't queue ${what}`, { ...fields, error: reason(e) });
  }
}

/** Marks what a stopped worker left "running" as interrupted (packages/db/src/sweep.ts). */
async function sweep() {
  const swept = await sweepInterrupted(db, await liveJobs(db));
  if (Object.values(swept).some((n) => n > 0)) log.warn("marked rows a stopped worker left behind as interrupted", { ...swept });
}

// Folders a worker killed mid-job left behind still hold a client's secret and token.
const stale = await removeStaleFolders();
if (stale) log.info("deleted temporary CLI folders left behind by an earlier run", { folders: stale });
if (mailer) {
  // Bad mail settings show at start, not after an alert failed three times.
  mailer.verify().then(
    () => log.info("the mail server in SMTP_URL answers"),
    (e) => log.error("the mail server in SMTP_URL doesn't answer: alerts can't be emailed until it does", { error: reason(e) }),
  );
} else {
  log.info("SMTP_URL is not set: alerts are recorded and shown in the app, but not emailed");
}
if (login.machineLogin) log.info("YSTARA_WORKER_MACHINE_LOGIN=1: tenants without a technical client are scanned with this machine's own CLI login");

await boss.start(); // queues are created by `npm run db:migrate`
await sweep();
await work<ScanJobData>(JOBS.scan, 2, async ({ scanId }) => {
  const scan = await runScan(db, scanId, (tenant) => tenantAccess(db, secrets, tenant, login));
  log.info("scan finished", { scan: scanId, status: scan?.status ?? "gone", error: scan?.error ?? undefined });
  if (scan?.status !== "succeeded") return;
  // The scenarios of each pipeline the scan changed run again, from the stored definitions only.
  await followUp("the suites after a scan", { scan: scan.id }, async () => {
    const after = await queueSuitesAfterScan(db, scan.id, async (suiteId, tx) => {
      await boss.send(JOBS.scenarioSuite, { suiteId } satisfies ScenarioSuiteJobData, onTx(tx));
    });
    if (after.queued || after.skipped) log.info("suites after a scan", { scan: scan.id, queued: after.queued, skipped: after.skipped });
  });
});
await work<ConnectionCheckJobData>(JOBS.connectionCheck, 2, async ({ tenantId }) => {
  const connection = await runConnectionCheck(db, tenantId, secrets, (host, client, spaces) => checkSpacesWith(host, client, spaces, login.bin));
  log.info("connection check finished", { tenant: tenantId, status: connection?.status ?? "gone" });
});
await work<DatabaseCheckJobData>(JOBS.databaseCheck, 2, async (data) => {
  const user = await runDatabaseCheck(db, data, secrets, checkDatabaseUser);
  log.info("database user check finished", { tenant: data.tenantId, space: data.space, status: user?.status ?? "gone" });
});
await work<SnapshotJobData>(JOBS.snapshot, 3, async ({ snapshotId }) => {
  const snapshot = await runSnapshot(db, snapshotId, secrets);
  log.info("snapshot finished", { snapshot: snapshotId, status: snapshot?.status ?? "gone", error: snapshot?.error ?? undefined });
  if (snapshot?.scheduled) {
    await followUp("a snapshot's alert", { snapshot: snapshot.id }, () => boss.send(JOBS.snapshotAlert, { snapshotId: snapshot.id } satisfies SnapshotAlertJobData));
  }
});
await work<SnapshotAlertJobData>(JOBS.snapshotAlert, 2, async ({ snapshotId }) => {
  const alert = await runSnapshotAlert(db, snapshotId, alerts);
  if (alert) log.info("snapshot alert", { snapshot: snapshotId, status: alert.status, recipients: alert.recipients, teams: alert.teams?.status });
});
await work<ScenarioRunJobData>(JOBS.scenarioRun, 3, async ({ runId }) => {
  const run = await runScenarioRun(db, runId, secrets);
  log.info("scenario run finished", { run: runId, status: run?.status ?? "gone", error: run?.error ?? undefined });
});
await work<ScenarioSuiteJobData>(JOBS.scenarioSuite, 2, async ({ suiteId }) => {
  const suite = await runScenarioSuite(db, suiteId, secrets);
  log.info("suite finished", { suite: suiteId, status: suite?.status ?? "gone", passed: suite?.passed ?? undefined, total: suite?.total ?? undefined });
  if (suite?.cause === "scan" && suite.status !== "passed") {
    await followUp("a suite's alert", { suite: suite.id }, () => boss.send(JOBS.scenarioAlert, { suiteId: suite.id } satisfies ScenarioAlertJobData));
  }
});
await work<ScenarioAlertJobData>(JOBS.scenarioAlert, 2, async ({ suiteId }) => {
  const alert = await runScenarioAlert(db, suiteId, alerts);
  if (alert) log.info("suite alert", { suite: suiteId, status: alert.status, recipients: alert.recipients, teams: alert.teams?.status });
});
// pg-boss's own cron sends one tick a minute, whichever worker sends it; the tick reads our schedules (pipeline_schedules, tenant_scan_schedules).
await boss.schedule(JOBS.scheduleTick, "* * * * *");
await work(JOBS.scheduleTick, 1, async () => {
  const now = new Date();
  // The sign of life /api/health reads: this worker takes jobs.
  await recordHeartbeat(db, worker);
  await sweep();
  // On the tick's transaction: a job exists only if its snapshot or scan and the schedule's next run are saved too.
  const snapshots = await runScheduleTick(db, now, async (snapshotId, tx) => {
    await boss.send(JOBS.snapshot, { snapshotId } satisfies SnapshotJobData, onTx(tx));
  });
  if (snapshots.queued || snapshots.skipped) log.info("snapshot schedules", { queued: snapshots.queued, skipped: snapshots.skipped });
  const scans = await runScanScheduleTick(db, now, async (scanId, tx) => {
    await boss.send(JOBS.scan, { scanId } satisfies ScanJobData, onTx(tx));
  });
  if (scans.queued || scans.skipped) log.info("scan schedules", { queued: scans.queued, skipped: scans.skipped });
});
// A first sign of life at once, so /api/health/worker turns green with the start rather than at the first tick.
await recordHeartbeat(db, worker);
log.info("started", { version, worker: worker.worker });

// A deploy stops the worker with SIGTERM: it takes no new job and gives those running 45 seconds to finish (Compose
// waits 60, stop_grace_period). pg-boss then fails those still running, and the sweep marks their rows interrupted.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info("stopping: letting the running jobs finish", { signal });
    await boss.stop({ graceful: true, timeout: 45_000 });
    await sweep().catch(() => undefined);
    mailer?.close();
    await db.close();
    process.exit(0);
  });
}
