/**
 * Erases a person from Ystara, as a GDPR erasure request asks: their sign-in,
 * memberships and watches go, and the audit log and sign-offs keep what was
 * done without their name or address. Final: there is no undo.
 *
 *   npm run user:erase -- --email person@example.com          # shows what it would do
 *   npm run user:erase -- --email person@example.com --yes    # does it
 *
 * Refused while the person is an account's only admin: make someone else an
 * admin there first (Users page), or delete the account (npm run account:delete).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertYstaraDatabase, connect, eraseUser, findUserByEmail, membershipsOf } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { email: { type: "string" }, yes: { type: "boolean", default: false } } });
const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run user:erase -- --email <email> [--yes]");
  process.exit(1);
}

const db = connect();
try {
  await assertYstaraDatabase(db);
  const user = await findUserByEmail(db, email);
  if (!user) {
    console.error(`There is no user ${email}.`);
    process.exit(1);
  }
  if (!values.yes) {
    const accounts = (await membershipsOf(db, user.id)).map((a) => a.name);
    console.log(`${email} belongs to ${accounts.length ? accounts.join(", ") : "no account"}.`);
    console.log("Erasing ends their sign-in and memberships, and removes their name and address from the audit log and sign-offs.");
    console.log("Nothing else changes. To do it, run the same command with --yes.");
  } else {
    const outcome = await eraseUser(db, email);
    if (!outcome.erased) {
      console.error(
        outcome.reason === "only_admin"
          ? `${email} is the only admin of ${outcome.accounts.join(", ")}. Make someone else an admin there first, or delete the account.`
          : `There is no user ${email}.`,
      );
      process.exit(1);
    }
    console.log(`${email} is erased${outcome.accounts.length ? `, and no longer in ${outcome.accounts.join(", ")}` : ""}.`);
  }
} finally {
  await db.close();
}
