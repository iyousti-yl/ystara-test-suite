/**
 * Makes an existing user Ystara's operator: they see the operator panel (every
 * account and user, never lineage data), create accounts and make reset links.
 * Only this command sets the flag; the web app can't.
 *
 *   npm run operator:grant -- --email you@example.com            # give
 *   npm run operator:grant -- --email you@example.com --revoke   # take away
 *
 * The user must exist: join an account first (npm run account:create).
 * It applies at once, also to a browser that is already signed in.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertYstaraDatabase, connect, setOperator } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { email: { type: "string" }, revoke: { type: "boolean", default: false } } });
const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run operator:grant -- --email <email of an existing user> [--revoke]");
  process.exit(1);
}

const db = connect();
try {
  await assertYstaraDatabase(db);
  if (!(await setOperator(db, email, !values.revoke))) {
    console.error(`There is no user ${email}. They join an account first: npm run account:create -- --name "<Account>" --admin ${email}`);
    process.exit(1);
  }
  console.log(values.revoke ? `${email} is no longer the operator.` : `${email} is now the operator: "Operator" appears in the top bar.`);
} finally {
  await db.close();
}
