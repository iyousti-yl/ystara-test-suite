/**
 * Worker entry point. Consumes jobs from Postgres (pg-boss), so there is no
 * separate queue service. Job types arrive per phase:
 *   discovery-scan    (phase 1) read spaces of a tenant into a stored lineage graph
 *   snapshot.capture  (phase 2) metrics of pipeline objects
 *   snapshot.compare  (phase 2)
 *   scenario.run      (phase 3) read-only simulation of a pipeline on fixtures
 *
 * Datasphere access: until the connection wizard stores per-tenant
 * credentials, scans use the Datasphere CLI's own login on the machine the
 * worker runs on (`datasphere login`). Everything stays read-only.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import { DatasphereCli } from "@ystara/connector";
import { connect, DEFAULT_DATABASE_URL } from "@ystara/db";
import { JOBS, type ScanJobData } from "@ystara/shared";
import { runScan } from "./jobs/scan.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const db = connect(url);
const boss = new PgBoss(url);
boss.on("error", (err) => console.error("[worker] queue error", err));

await boss.start(); // queues are created by `npm run db:migrate`
await boss.work<ScanJobData>(JOBS.scan, async ([job]) => {
  const scan = await runScan(db, job.data.scanId, (tenant) => {
    if (!tenant.host) throw new Error(`Tenant "${tenant.name}" has no Datasphere URL; it only has imported scans.`);
    return new DatasphereCli({ host: tenant.host, bin: process.env.DSP_CLI_BIN });
  });
  console.log(`[worker] scan ${job.data.scanId}: ${scan?.status ?? "gone"}${scan?.error ? ` (${scan.error})` : ""}`);
});
console.log("[worker] started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await boss.stop({ graceful: true });
    await db.close();
    process.exit(0);
  });
}
