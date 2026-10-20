/**
 * Worker entry point. Consumes jobs from Postgres (pg-boss), so there is no
 * separate queue service. Job types arrive per phase:
 *   discovery-scan    (phase 1) read spaces of a tenant into a stored lineage graph
 *   connection-check  (phase 1) log in with a tenant's technical client and check it can read its spaces
 *   database-check    (phase 2) sign in with a space's database user and list what it can read there
 *   snapshot-capture  (phase 2) measure a pipeline's steps with SQL (counts, hashes, sums; never rows)
 *   snapshot-schedule-tick (phase 2) every minute: queue the snapshots whose pipeline schedule has come
 *   snapshot-alert    (phase 2) after a scheduled snapshot: compare it with the one before, email the watchers if needed
 *   scenario-run      (phase 3) send a scenario's checks as SELECTs that read only its own rows (and DUMMY)
 *
 * Datasphere access: each tenant's technical client for the CLI, and each
 * space's database user for SQL. The worker opens their secrets with
 * MASTER_KEY. A tenant without a client is not scanned, unless this
 * worker runs on a developer's computer with YSTARA_WORKER_MACHINE_LOGIN=1:
 * then it uses the Datasphere CLI's own login there (see tenant-login.ts).
 * Everything stays read-only.
 *
 * Alert emails go through the mail server in SMTP_URL (smtp://user:password@host:587,
 * or smtps:// on port 465), from SMTP_FROM, with links to YSTARA_PUBLIC_URL. Without
 * SMTP_URL, alerts are only recorded. Docker Compose points it at Mailpit, a local inbox.
 */
import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";
import PgBoss from "pg-boss";
import { checkDatabaseUser } from "@ystara/connector";
import { assertYstaraDatabase, connect, databaseUrl } from "@ystara/db";
import {
  JOBS,
  type ConnectionCheckJobData,
  type DatabaseCheckJobData,
  type ScanJobData,
  type ScenarioRunJobData,
  type SnapshotAlertJobData,
  type SnapshotJobData,
} from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";
import { masterKeyFromEnv, secretBox } from "@ystara/shared/secrets";
import { runConnectionCheck } from "./jobs/connection-check.js";
import { runDatabaseCheck } from "./jobs/database-check.js";
import { runScan } from "./jobs/scan.js";
import { runScenarioRun } from "./jobs/scenario-run.js";
import { runScheduleTick } from "./jobs/schedule-tick.js";
import { runSnapshotAlert, type SendMail } from "./jobs/snapshot-alert.js";
import { runSnapshot } from "./jobs/snapshot.js";
import { checkSpacesWith, removeStaleFolders, tenantAccess, type LoginOptions } from "./tenant-login.js";

loadLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));
const secrets = secretBox(masterKeyFromEnv()); // before anything else, so a missing key stops the start at once
const login: LoginOptions = { bin: process.env.DSP_CLI_BIN, machineLogin: process.env.YSTARA_WORKER_MACHINE_LOGIN === "1" };
const appUrl = process.env.YSTARA_PUBLIC_URL ?? `http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}`;
const mailer = process.env.SMTP_URL ? createTransport(process.env.SMTP_URL, { from: process.env.SMTP_FROM ?? "Ystara <ystara@localhost>" }) : undefined;
const send: SendMail | null = mailer ? async (mail) => void (await mailer.sendMail(mail)) : null;

const url = databaseUrl();
const db = connect(url);
await assertYstaraDatabase(db); // before pg-boss creates its own tables in someone else's database
const boss = new PgBoss(url);
boss.on("error", (err) => console.error("[worker] queue error", err));

// Folders a worker killed mid-job left behind still hold a client's secret and token.
const stale = await removeStaleFolders();
if (stale) console.log(`[worker] deleted ${stale} temporary CLI folder(s) left behind by an earlier run`);
if (!send) console.log("[worker] SMTP_URL is not set: alerts are recorded and shown in the app, but not emailed");
if (login.machineLogin) console.log("[worker] YSTARA_WORKER_MACHINE_LOGIN=1: tenants without a technical client are scanned with this machine's own CLI login");

await boss.start(); // queues are created by `npm run db:migrate`
await boss.work<ScanJobData>(JOBS.scan, async ([job]) => {
  const scan = await runScan(db, job.data.scanId, (tenant) => tenantAccess(db, secrets, tenant, login));
  console.log(`[worker] scan ${job.data.scanId}: ${scan?.status ?? "gone"}${scan?.error ? ` (${scan.error})` : ""}`);
});
await boss.work<ConnectionCheckJobData>(JOBS.connectionCheck, async ([job]) => {
  const connection = await runConnectionCheck(db, job.data.tenantId, secrets, (host, client, spaces) => checkSpacesWith(host, client, spaces, login.bin));
  console.log(`[worker] connection check of tenant ${job.data.tenantId}: ${connection?.status ?? "gone"}`);
});
await boss.work<DatabaseCheckJobData>(JOBS.databaseCheck, async ([job]) => {
  const user = await runDatabaseCheck(db, job.data, secrets, checkDatabaseUser);
  console.log(`[worker] database check of space ${job.data.space} in tenant ${job.data.tenantId}: ${user?.status ?? "gone"}`);
});
await boss.work<SnapshotJobData>(JOBS.snapshot, async ([job]) => {
  const snapshot = await runSnapshot(db, job.data.snapshotId, secrets);
  console.log(`[worker] snapshot ${job.data.snapshotId}: ${snapshot?.status ?? "gone"}${snapshot?.error ? ` (${snapshot.error})` : ""}`);
  if (snapshot?.scheduled) await boss.send(JOBS.snapshotAlert, { snapshotId: snapshot.id } satisfies SnapshotAlertJobData);
});
await boss.work<SnapshotAlertJobData>(JOBS.snapshotAlert, async ([job]) => {
  const alert = await runSnapshotAlert(db, job.data.snapshotId, { send, appUrl });
  if (alert) console.log(`[worker] alert for snapshot ${job.data.snapshotId}: ${alert.status}${alert.recipients ? ` to ${alert.recipients} watcher(s)` : ""}`);
});
await boss.work<ScenarioRunJobData>(JOBS.scenarioRun, async ([job]) => {
  const run = await runScenarioRun(db, job.data.runId, secrets);
  console.log(`[worker] scenario run ${job.data.runId}: ${run?.status ?? "gone"}${run?.error ? ` (${run.error})` : ""}`);
});
// pg-boss's own cron sends one tick a minute, whichever worker sends it; the tick reads our schedules (pipeline_schedules).
await boss.schedule(JOBS.scheduleTick, "* * * * *");
await boss.work(JOBS.scheduleTick, async () => {
  const { queued, skipped } = await runScheduleTick(db, new Date(), async (snapshotId, tx) => {
    // On the tick's transaction: the job exists only if the snapshot and the schedule's next run are saved too.
    await boss.send(JOBS.snapshot, { snapshotId } satisfies SnapshotJobData, { db: { executeSql: (text, values) => tx.query(text, values) } });
  });
  if (queued || skipped) console.log(`[worker] schedules: ${queued} snapshot(s) queued, ${skipped} skipped (the previous one unfinished, or a tenant without a database)`);
});
console.log("[worker] started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await boss.stop({ graceful: true });
    await db.close();
    process.exit(0);
  });
}
