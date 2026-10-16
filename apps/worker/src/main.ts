/**
 * Worker entry point. Consumes jobs from Postgres (pg-boss), so there is no
 * separate queue service. Job types arrive per phase:
 *   discovery-scan    (phase 1) read spaces of a tenant into a stored lineage graph
 *   connection-check  (phase 1) log in with a tenant's technical client and list its spaces
 *   snapshot.capture  (phase 2) metrics of pipeline objects
 *   snapshot.compare  (phase 2)
 *   scenario.run      (phase 3) read-only simulation of a pipeline on fixtures
 *
 * Datasphere access: each tenant's technical client, whose secret the worker
 * opens with MASTER_KEY; for a tenant without one, the Datasphere CLI's own
 * login on this machine (see tenant-login.ts). Everything stays read-only.
 */
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import { assertYstaraDatabase, connect, databaseUrl } from "@ystara/db";
import { JOBS, type ConnectionCheckJobData, type ScanJobData } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";
import { masterKeyFromEnv, secretBox } from "@ystara/shared/secrets";
import { runConnectionCheck } from "./jobs/connection-check.js";
import { runScan } from "./jobs/scan.js";
import { listSpacesWith, tenantAccess } from "./tenant-login.js";

loadLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));
const secrets = secretBox(masterKeyFromEnv()); // before anything else, so a missing key stops the start at once
const bin = process.env.DSP_CLI_BIN;

const url = databaseUrl();
const db = connect(url);
await assertYstaraDatabase(db); // before pg-boss creates its own tables in someone else's database
const boss = new PgBoss(url);
boss.on("error", (err) => console.error("[worker] queue error", err));

await boss.start(); // queues are created by `npm run db:migrate`
await boss.work<ScanJobData>(JOBS.scan, async ([job]) => {
  const scan = await runScan(db, job.data.scanId, (tenant) => tenantAccess(db, secrets, tenant, bin));
  console.log(`[worker] scan ${job.data.scanId}: ${scan?.status ?? "gone"}${scan?.error ? ` (${scan.error})` : ""}`);
});
await boss.work<ConnectionCheckJobData>(JOBS.connectionCheck, async ([job]) => {
  const connection = await runConnectionCheck(db, job.data.tenantId, secrets, (host, client) => listSpacesWith(host, client, bin));
  console.log(`[worker] connection check of tenant ${job.data.tenantId}: ${connection?.status ?? "gone"}`);
});
console.log("[worker] started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await boss.stop({ graceful: true });
    await db.close();
    process.exit(0);
  });
}
