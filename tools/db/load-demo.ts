/**
 * Adds the synthetic demo tenant (tools/db/demo.ts) to an account: a scan,
 * a saved pipeline and two snapshots, with technical names as long as
 * Datasphere allows. For looking at the web app, and for `npm run
 * check:browser`, without a real tenant. No tenant calls.
 *
 *   npm run db:demo -- [--account <name>]
 *
 * --account can be left out while the database has one account. Needs the
 * database running and migrated, and an account (`npm run account:create`).
 * The tenant is called "Synthetic demo"; to load it again, delete it from its
 * Home first.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertYstaraDatabase, connect, listAccounts } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";
import { loadDemo } from "./demo.js";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { account: { type: "string" } } });

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
          : `Say which account the demo is for: --account <name>. Accounts: ${known}.`,
    );
    process.exit(1);
  }
  const { tenant, pipeline } = await loadDemo(db, account.id).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
  console.log(`Added the demo tenant "${tenant.name}" to account "${account.name}", with a scan, a pipeline and two snapshots.`);
  console.log(`Open it in the web app: http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}/pipelines/${pipeline.id}/snapshots`);
} finally {
  await db.close();
}
