import type { Db } from "./db.js";

/**
 * Erasing a person and deleting an account, for the operator's command line
 * (npm run user:erase, npm run account:delete). The app has no button for
 * either: both are final, and asked for in writing (a GDPR request, the end
 * of a contract).
 */

export type EraseOutcome = { erased: true; accounts: string[] } | { erased: false; reason: "unknown" } | { erased: false; reason: "only_admin"; accounts: string[] };

/**
 * Erases a user: their sign-in (password, authenticator, sessions, reset links), their memberships and what they
 * watch go; the audit log keeps its events but no longer says who or from where ("A user since deleted"); their
 * sign-offs stand, signed by "erased user". Refused while they are an account's only admin: that account would
 * have no one left to run it.
 */
export async function eraseUser(db: Db, email: string): Promise<EraseOutcome> {
  return db.transaction(async (tx) => {
    const user = (await tx.query<{ id: string }>("select id from users where email = $1 for update", [email.trim().toLowerCase()])).rows[0];
    if (!user) return { erased: false, reason: "unknown" };
    const { rows: alone } = await tx.query<{ name: string }>(
      `select a.name from memberships m join accounts a on a.id = m.account_id
       where m.user_id = $1 and m.role = 'admin'
         and not exists (select 1 from memberships o where o.account_id = m.account_id and o.role = 'admin' and o.user_id <> $1)
       order by a.name`,
      [user.id],
    );
    if (alone.length) return { erased: false, reason: "only_admin", accounts: alone.map((a) => a.name) };
    const { rows: accounts } = await tx.query<{ name: string }>(
      "select a.name from memberships m join accounts a on a.id = m.account_id where m.user_id = $1 order by a.name",
      [user.id],
    );
    const address = email.trim().toLowerCase();
    await tx.query("update audit_events set user_email = null, ip = null where user_id = $1 or user_email = $2", [user.id, address]);
    // Where the person was what an event was about (invited, made admin, given a reset link), or named in its detail.
    await tx.query("update audit_events set target = jsonb_set(target, '{name}', 'null') where target->>'name' = $1", [address]);
    await tx.query("update audit_events set detail = detail - 'email' where detail->>'email' = $1", [address]);
    await tx.query("update audit_events set detail = detail - 'adminEmail' where detail->>'adminEmail' = $1", [address]);
    await tx.query("update pipeline_signoffs set signed_email = 'erased user' where signed_by = $1 or signed_email = $2", [user.id, address]);
    await tx.query("delete from invitations where email = $1", [address]);
    // Sessions, memberships, reset links and watches go with the user (on delete cascade); what they created or
    // ran stays, without their name (on delete set null).
    await tx.query("delete from users where id = $1", [user.id]);
    return { erased: true, accounts: accounts.map((a) => a.name) };
  });
}

export interface AccountFootprint {
  id: string;
  name: string;
  tenants: number;
  members: number;
  scans: number;
  pipelines: number;
  /** Members who belong to no other account: their sign-in stays until each is erased. */
  onlyHere: string[];
}

/** What deleting the account would remove, to show before doing it. */
export async function accountFootprint(db: Db, name: string): Promise<AccountFootprint | undefined> {
  const { rows } = await db.query<{ id: string; name: string; tenants: number; members: number; scans: number; pipelines: number }>(
    `select a.id, a.name,
        (select count(*)::int from tenants t where t.account_id = a.id) as tenants,
        (select count(*)::int from memberships m where m.account_id = a.id) as members,
        (select count(*)::int from scans s join tenants t on t.id = s.tenant_id where t.account_id = a.id) as scans,
        (select count(*)::int from pipelines p join tenants t on t.id = p.tenant_id where t.account_id = a.id) as pipelines
     from accounts a where a.name = $1`,
    [name],
  );
  const account = rows[0];
  if (!account) return undefined;
  const { rows: onlyHere } = await db.query<{ email: string }>(
    `select u.email from memberships m join users u on u.id = m.user_id
     where m.account_id = $1 and not exists (select 1 from memberships o where o.user_id = m.user_id and o.account_id <> $1)
     order by u.email`,
    [account.id],
  );
  return { ...account, onlyHere: onlyHere.map((u) => u.email) };
}

/**
 * Deletes an account with everything stored for it: its tenants first (scans, pipelines, scenarios, snapshots,
 * results, connections and database users go with each), then the account (members, invitations, audit log, Teams
 * channel). Its members' sign-ins stay: someone may belong to another account too.
 */
export async function deleteAccount(db: Db, accountId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query("delete from tenants where account_id = $1", [accountId]);
    return (await tx.query("delete from accounts where id = $1 returning id", [accountId])).rows.length > 0;
  });
}
