/**
 * Creates a customer account and an invitation link for its first admin.
 * There is no sign-up page: accounts are created by Ystara's operator, with
 * this command; the admin then invites the rest of the team from the web app.
 *
 *   npm run account:create -- --name "Customer" --admin first.admin@customer.example.com
 *
 * When the account already exists (e.g. "Default", which holds the tenants
 * from before sign-in), it only creates the invitation. The link is valid for
 * 7 days and works once; it is printed here and stored only as a hash.
 * The link starts with YSTARA_PUBLIC_URL, or http://127.0.0.1:<YSTARA_API_PORT>.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertYstaraDatabase, connect, createAccount, createInvitation, findAccountByName, listMembers } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { values } = parseArgs({ options: { name: { type: "string" }, admin: { type: "string" } } });
const name = values.name?.trim();
const email = values.admin?.trim().toLowerCase();
if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run account:create -- --name "<Account name>" --admin <email of its first admin>');
  process.exit(1);
}

const db = connect();
try {
  await assertYstaraDatabase(db);
  const existing = await findAccountByName(db, name);
  const account = existing ?? (await createAccount(db, name));
  if (existing && (await listMembers(db, account.id)).some((m) => m.email === email)) {
    console.error(`${email} is already a member of "${name}".`);
    process.exit(1);
  }
  const { token } = await createInvitation(db, { accountId: account.id, email, role: "admin" });
  const base = (process.env.YSTARA_PUBLIC_URL ?? `http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}`).replace(/\/+$/, "");
  console.log(existing ? `Account "${name}" already exists; invited ${email} as admin.` : `Created account "${name}" and invited ${email} as its admin.`);
  console.log(`\nSend this link to ${email}. It works once, for 7 days:\n\n  ${base}/invite/${token}\n`);
  console.log('They choose a password and set up an authenticator app there, then invite their team on the "Users and roles" page.');
} finally {
  await db.close();
}
