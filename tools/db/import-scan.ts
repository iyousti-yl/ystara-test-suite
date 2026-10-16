/**
 * Loads a saved scan folder (from `npm run scan`) into the database, so the API
 * (and later the web app) can serve its lineage and pipelines. No tenant calls:
 * the lineage graph is rebuilt from raw.json with the current parser.
 *
 *   npm run db:import -- --from tools/scan/output/<run> --tenant Partner [--host https://<tenant>.hcs.cloud.sap] [--account <name>]
 *
 * The tenant is created in the account if it doesn't exist yet. --account can
 * be left out while the database has one account. Needs the database running
 * (`docker compose up -d`) and migrated, and an account (`npm run account:create`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import { assertYstaraDatabase, connect, createScan, createTenant, findTenantByName, listAccounts, saveScanResult } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { from: { type: "string" }, tenant: { type: "string" }, host: { type: "string" }, account: { type: "string" } } });
if (!values.from || !values.tenant) {
  console.error("Usage: npm run db:import -- --from <scan folder> --tenant <name> [--host <https URL>] [--account <name>]");
  process.exit(1);
}

const saved = JSON.parse(await readFile(path.resolve(values.from, "raw.json"), "utf8")) as { spaces: string[]; raw: RawObject[]; warnings: string[] };
const db = connect();
try {
  await assertYstaraDatabase(db);
  const accounts = await listAccounts(db);
  const account = values.account ? accounts.find((a) => a.name === values.account) : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) {
    const known = accounts.map((a) => `"${a.name}"`).join(", ");
    console.error(
      accounts.length === 0
        ? 'There is no account yet. Create one first: npm run account:create -- --name "<Account>" --admin <your email>'
        : values.account
          ? `There is no account "${values.account}". Accounts: ${known}.`
          : `Say which account the scan is for: --account <name>. Accounts: ${known}.`,
    );
    process.exit(1);
  }
  const tenant =
    (await findTenantByName(db, account.id, values.tenant)) ?? (await createTenant(db, { accountId: account.id, name: values.tenant, host: values.host ?? null }));
  const scan = await createScan(db, tenant.id, saved.spaces, "import");
  const stored = await saveScanResult(db, scan.id, saved.raw, graphFromRaw(saved.raw, saved.spaces, saved.warnings));
  console.log(`Imported ${stored.objectCount} objects and ${stored.edgeCount} edges into tenant "${tenant.name}" of account "${account.name}".`);
  console.log(`Scan ${stored.id}. Open it in the web app: http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}/scans/${stored.id}`);
} finally {
  await db.close();
}
