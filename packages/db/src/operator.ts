import type { AccountOverview, Role, UserOverview } from "@ystara/shared";
import { hashToken, newToken } from "./accounts.js";
import type { Db, Queryable } from "./db.js";

/**
 * What the operator panel reads and does (migration 004): every account and
 * user with counts and memberships, never tenants' scans or pipelines; the
 * operator flag; and one-time links that reset someone's sign-in.
 */

/** Gives or takes the operator flag. False when there is no user with that email. */
export async function setOperator(db: Queryable, email: string, operator: boolean): Promise<boolean> {
  const { rows } = await db.query("update users set operator = $2 where email = $1 returning id", [email.toLowerCase(), operator]);
  return rows.length === 1;
}

export async function listAccountOverviews(db: Queryable): Promise<AccountOverview[]> {
  const { rows } = await db.query<{ id: string; name: string; created_at: Date; members: number; admins: number; tenants: number; open_invitations: number }>(
    `select a.id, a.name, a.created_at,
       (select count(*)::int from memberships m where m.account_id = a.id) as members,
       (select count(*)::int from memberships m where m.account_id = a.id and m.role = 'admin') as admins,
       (select count(*)::int from tenants t where t.account_id = a.id) as tenants,
       (select count(*)::int from invitations i where i.account_id = a.id and i.accepted_at is null and i.expires_at > now()) as open_invitations
     from accounts a order by a.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, members: r.members, admins: r.admins, tenants: r.tenants, openInvitations: r.open_invitations }));
}

export async function listUserOverviews(db: Queryable): Promise<UserOverview[]> {
  const { rows } = await db.query<{ id: string; email: string; operator: boolean; created_at: Date; accounts: { id: string; name: string; role: Role }[] }>(
    `select u.id, u.email, u.operator, u.created_at,
       coalesce((select json_agg(json_build_object('id', a.id, 'name', a.name, 'role', m.role) order by a.name)
                 from memberships m join accounts a on a.id = m.account_id where m.user_id = u.id), '[]') as accounts
     from users u order by u.email`,
  );
  return rows.map((r) => ({ id: r.id, email: r.email, operator: r.operator, createdAt: r.created_at, accounts: r.accounts }));
}

const RESET_DAYS = 3;

/** A new reset link for a user; earlier open ones stop working. The token is not stored: show it once. */
export async function createSignInReset(db: Db, userId: string): Promise<{ token: string; expiresAt: Date } | undefined> {
  return db.transaction(async (tx) => {
    const { rows: users } = await tx.query("select id from users where id = $1", [userId]);
    if (users.length === 0) return undefined;
    await tx.query("delete from sign_in_resets where user_id = $1 and used_at is null", [userId]);
    const token = newToken();
    const { rows } = await tx.query<{ expires_at: Date }>(
      "insert into sign_in_resets (user_id, token_hash, expires_at) values ($1, $2, now() + make_interval(days => $3)) returning expires_at",
      [userId, hashToken(token), RESET_DAYS],
    );
    return { token, expiresAt: rows[0].expires_at };
  });
}

/** The user behind an open reset link, or undefined when it is unknown, used or expired. */
export async function findOpenSignInReset(db: Queryable, token: string): Promise<{ userId: string; email: string } | undefined> {
  const { rows } = await db.query<{ user_id: string; email: string }>(
    `select r.user_id, u.email from sign_in_resets r join users u on u.id = r.user_id
     where r.token_hash = $1 and r.used_at is null and r.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] && { userId: rows[0].user_id, email: rows[0].email };
}

/**
 * Uses a reset link: the new password and authenticator replace the old ones
 * and every session of the user ends, all at once. Undefined when the link was
 * used or expired in the meantime.
 */
export async function useSignInReset(db: Db, token: string, input: { passwordHash: string; totpSecret: string; totpStep: number }): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ user_id: string }>(
      "update sign_in_resets set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id",
      [hashToken(token)],
    );
    const userId = rows[0]?.user_id;
    if (!userId) return undefined;
    await tx.query("update users set password_hash = $2, totp_secret = $3, totp_last_step = $4 where id = $1", [userId, input.passwordHash, input.totpSecret, input.totpStep]);
    await tx.query("delete from sessions where user_id = $1", [userId]);
    return userId;
  });
}
