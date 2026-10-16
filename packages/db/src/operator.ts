import type { AccountOverview, Invitation, Role, UserOverview } from "@ystara/shared";
import { createInvitation, hashToken, newToken } from "./accounts.js";
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

/**
 * A new reset link for a user, made by the operator `createdBy`; earlier open ones stop working (they stay
 * on record). An operator's sign-in can't be reset this way: one operator would take over another.
 * The token is not stored: show it once.
 */
export async function createSignInReset(
  db: Db,
  userId: string,
  createdBy: string,
): Promise<{ token: string; expiresAt: Date } | "not-found" | "operator"> {
  return db.transaction(async (tx) => {
    // Locks the user, so two links made at the same time can't both stay open.
    const { rows: users } = await tx.query<{ operator: boolean }>("select operator from users where id = $1 for update", [userId]);
    if (users.length === 0) return "not-found";
    if (users[0].operator) return "operator";
    await tx.query("update sign_in_resets set expires_at = now() where user_id = $1 and used_at is null and expires_at > now()", [userId]);
    const token = newToken();
    const { rows } = await tx.query<{ expires_at: Date }>(
      "insert into sign_in_resets (user_id, created_by, token_hash, expires_at) values ($1, $2, $3, now() + make_interval(days => $4)) returning expires_at",
      [userId, createdBy, hashToken(token), RESET_DAYS],
    );
    return { token, expiresAt: rows[0].expires_at };
  });
}

const OPEN_RESET = "token_hash = $1 and used_at is null and expires_at > now()";

/** The user behind an open reset link, or undefined when it is unknown, used or expired. */
export async function findOpenSignInReset(db: Queryable, token: string): Promise<{ userId: string; email: string } | undefined> {
  const { rows } = await db.query<{ user_id: string; email: string }>(
    `select r.user_id, u.email from sign_in_resets r join users u on u.id = r.user_id where ${OPEN_RESET}`,
    [hashToken(token)],
  );
  return rows[0] && { userId: rows[0].user_id, email: rows[0].email };
}

/** Keeps the authenticator secret the server made for an open reset link (sealed), replacing any earlier one. */
export async function setSignInResetTotpSecret(db: Queryable, token: string, sealedSecret: string): Promise<boolean> {
  const { rows } = await db.query(`update sign_in_resets set totp_secret = $2 where ${OPEN_RESET} returning id`, [hashToken(token), sealedSecret]);
  return rows.length === 1;
}

/** The sealed authenticator secret kept for an open reset link; undefined before the setup was opened. */
export async function signInResetTotpSecret(db: Queryable, token: string): Promise<string | undefined> {
  const { rows } = await db.query<{ totp_secret: string | null }>(`select totp_secret from sign_in_resets where ${OPEN_RESET}`, [hashToken(token)]);
  return rows[0]?.totp_secret ?? undefined;
}

/**
 * Uses a reset link: the new password and authenticator replace the old ones,
 * wrong codes are forgotten and every session of the user ends, all at once.
 * Undefined when the link was used or expired in the meantime.
 */
export async function useSignInReset(db: Db, token: string, input: { passwordHash: string; totpSecret: string; totpStep: number }): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ user_id: string }>(`update sign_in_resets set used_at = now() where ${OPEN_RESET} returning user_id`, [hashToken(token)]);
    const userId = rows[0]?.user_id;
    if (!userId) return undefined;
    await tx.query(
      "update users set password_hash = $2, totp_secret = $3, totp_last_step = $4, failed_codes = 0, codes_locked_until = null where id = $1",
      [userId, input.passwordHash, input.totpSecret, input.totpStep],
    );
    await tx.query("delete from sessions where user_id = $1", [userId]);
    return userId;
  });
}

/**
 * An invitation for a new admin, made by the operator, only for an account that has no admin left (its
 * admins left the company or lost access). Where an admin is left, they invite people themselves:
 * otherwise the operator could make themselves admin of any customer and see its data. The account
 * stays locked until the invitation exists, so a check and an invitation can't overlap.
 * Someone who is already a member is refused ("member"): accepting never changes an existing member's
 * role, so their invitation would be used up and the account would still have no admin.
 */
export async function inviteAdminWhereNoneLeft(
  db: Db,
  accountId: string,
  email: string,
): Promise<{ invitation: Invitation; token: string } | "not-found" | "has-admin" | "member"> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query("select id from accounts where id = $1 for update", [accountId]);
    if (rows.length === 0) return "not-found";
    const { rows: admins } = await tx.query("select 1 from memberships where account_id = $1 and role = 'admin' limit 1", [accountId]);
    if (admins.length > 0) return "has-admin";
    const { rows: members } = await tx.query(
      "select 1 from memberships m join users u on u.id = m.user_id where m.account_id = $1 and u.email = $2",
      [accountId, email.toLowerCase()],
    );
    if (members.length > 0) return "member";
    return createInvitation(tx, { accountId, email, role: "admin" });
  });
}
