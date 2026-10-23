/**
 * Deletes an account with everything stored for it: its tenants (scans,
 * pipelines, scenarios, snapshots, results, connections, database users), its
 * members, invitations, audit log and Teams channel. For the end of a contract.
 * Final: there is no undo, except a backup (deploy/README.md).
 *
 *   npm run account:delete -- --name "Customer"          # shows what it would delete
 *   npm run account:delete -- --name "Customer" --yes    # deletes it
 *
 * Members keep their sign-in: someone may belong to another account too. Those
 * who belonged to this account only are listed, to erase with npm run user:erase.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { accountFootprint, assertYstaraDatabase, connect, deleteAccount } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { name: { type: "string" }, yes: { type: "boolean", default: false } } });
const name = values.name?.trim();
if (!name) {
  console.error('Usage: npm run account:delete -- --name "<Account>" [--yes]');
  process.exit(1);
}

const db = connect();
try {
  await assertYstaraDatabase(db);
  const account = await accountFootprint(db, name);
  if (!account) {
    console.error(`There is no account named "${name}".`);
    process.exit(1);
  }
  const what = `${account.tenants} tenant(s), ${account.scans} scan(s), ${account.pipelines} pipeline(s) and ${account.members} member(s)`;
  if (!values.yes) {
    console.log(`"${account.name}" has ${what}. Deleting it removes all of that, and its audit log.`);
    console.log("To do it, run the same command with --yes.");
  } else {
    await deleteAccount(db, account.id);
    console.log(`"${account.name}" is deleted, with ${what}.`);
  }
  if (account.onlyHere.length) {
    console.log(`${values.yes ? "These people belonged" : "These people belong"} to this account only; their sign-in stays until you erase them:`);
    for (const email of account.onlyHere) console.log(`  npm run user:erase -- --email ${email} --yes`);
  }
} finally {
  await db.close();
}
