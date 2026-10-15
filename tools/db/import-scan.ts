/**
 * Loads a saved scan folder (from `npm run scan`) into the database, so the API
 * (and later the web app) can serve its lineage and pipelines. No tenant calls:
 * the lineage graph is rebuilt from raw.json with the current parser.
 *
 *   npm run db:import -- --from tools/scan/output/<run> --tenant Partner [--host https://<tenant>.hcs.cloud.sap]
 *
 * The tenant is created if it doesn't exist yet. Needs the database running
 * (`docker compose up -d`) and migrated.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import { assertYstaraDatabase, connect, createScan, createTenant, findTenantByName, saveScanResult } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { from: { type: "string" }, tenant: { type: "string" }, host: { type: "string" } } });
if (!values.from || !values.tenant) {
  console.error("Usage: npm run db:import -- --from <scan folder> --tenant <name> [--host <https URL>]");
  process.exit(1);
}

const saved = JSON.parse(await readFile(path.resolve(values.from, "raw.json"), "utf8")) as { spaces: string[]; raw: RawObject[]; warnings: string[] };
const db = connect();
try {
  await assertYstaraDatabase(db);
  const tenant = (await findTenantByName(db, values.tenant)) ?? (await createTenant(db, { name: values.tenant, host: values.host ?? null }));
  const scan = await createScan(db, tenant.id, saved.spaces, "import");
  const stored = await saveScanResult(db, scan.id, saved.raw, graphFromRaw(saved.raw, saved.spaces, saved.warnings));
  console.log(`Imported ${stored.objectCount} objects and ${stored.edgeCount} edges into tenant "${tenant.name}".`);
  console.log(`Scan ${stored.id}. Try: curl "http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}/api/scans/${stored.id}/pipeline?output=<SPACE.VIEW>"`);
} finally {
  await db.close();
}
