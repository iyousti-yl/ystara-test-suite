import { createHash, randomBytes } from "node:crypto";
import type { Account, Invitation, Member, Role } from "@ystara/shared";
import type { Db, Queryable } from "./db.js";

/**
 * Customer accounts, their users and roles, invitations and sign-in sessions
 * (migration 003). Only storage lives here; passwords, authenticator codes and
 * the rules of signing in are in apps/api/src/auth.
 */
export type { Account, Invitation, Member };

/** A random token for a link or a cookie. Only its hash (hashToken) is ever stored. */
export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// --- Accounts

export async function createAccount(db: Queryable, name: string): Promise<Account> {
  const { rows } = await db.query<Account>("insert into accounts (name) values ($1) returning id, name", [name]);
  return rows[0];
}

export async function getAccount(db: Queryable, id: string): Promise<Account | undefined> {
  const { rows } = await db.query<Account>("select id, name from accounts where id = $1", [id]);
  return rows[0];
}

export async function findAccountByName(db: Queryable, name: string): Promise<Account | undefined> {
  const { rows } = await db.query<Account>("select id, name from accounts where name = $1", [name]);
  return rows[0];
}

export async function listAccounts(db: Queryable): Promise<Account[]> {
  return (await db.query<Account>("select id, name from accounts order by name")).rows;
}

// --- Users

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  /** Sealed with MASTER_KEY; apps/api opens it. */
  totpSecret: string;
  /** After too many wrong codes, no code is checked before this time. */
  codesLockedUntil: Date | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret: string;
  codes_locked_until: Date | null;
}
const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  totpSecret: r.totp_secret,
  codesLockedUntil: r.codes_locked_until,
});

export async function findUserByEmail(db: Queryable, email: string): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>("select * from users where email = $1", [email.toLowerCase()]);
  return rows[0] && toUser(rows[0]);
}

export async function getUser(db: Queryable, id: string): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>("select * from users where id = $1", [id]);
  return rows[0] && toUser(rows[0]);
}

/**
 * Records that the authenticator code of time step `step` was used, and
 * forgets earlier wrong codes. False when that code or a later one was already
 * used, so each code signs in only once.
 */
export async function useTotpStep(db: Queryable, userId: string, step: number): Promise<boolean> {
  const { rows } = await db.query(
    "update users set totp_last_step = $2, failed_codes = 0, codes_locked_until = null where id = $1 and totp_last_step < $2 returning id",
    [userId, step],
  );
  return rows.length === 1;
}

/**
 * Claims one code attempt for a user before the code is checked, whichever
 * session it comes from, so signing in with the password again doesn't start
 * the count over. The claim and the lock check are one statement, so
 * simultaneous requests can't check more codes than the rule allows: from the
 * `lockAfter`th attempt in a row, codes are locked for 1 minute, then 2, 4,
 * ... up to `maxMinutes`. A right code forgets the attempts (useTotpStep).
 * Returns whether this attempt may check a code, and the lock this attempt
 * set or found.
 */
export async function claimCodeAttempt(
  db: Queryable,
  userId: string,
  rule: { lockAfter: number; maxMinutes: number },
): Promise<{ allowed: boolean; lockedUntil: Date | null }> {
  const { rows } = await db.query<{ claimed: boolean; codes_locked_until: Date | null }>(
    `with claimed as (
       update users set failed_codes = failed_codes + 1,
         codes_locked_until = case when failed_codes + 1 >= $2
           then now() + make_interval(mins => least(power(2, least(failed_codes + 1 - $2, 10))::int, $3)) end
       where id = $1 and (codes_locked_until is null or codes_locked_until <= now())
       returning codes_locked_until
     )
     select true as claimed, codes_locked_until from claimed
     union all
     select false, codes_locked_until from users where id = $1 and not exists (select 1 from claimed)`,
    [userId, rule.lockAfter, rule.maxMinutes],
  );
  const row = rows[0];
  return { allowed: row?.claimed ?? false, lockedUntil: row?.codes_locked_until ?? null };
}

// --- Memberships

export async function membershipsOf(db: Queryable, userId: string): Promise<(Account & { role: Role })[]> {
  const { rows } = await db.query<Account & { role: Role }>(
    "select a.id, a.name, m.role from memberships m join accounts a on a.id = m.account_id where m.user_id = $1 order by m.created_at, a.name",
    [userId],
  );
  return rows;
}

export async function listMembers(db: Queryable, accountId: string): Promise<Member[]> {
  // With each member, the latest sign-in reset Ystara's operator made for them that was used or is still open.
  const { rows } = await db.query<{ user_id: string; email: string; role: Role; created_at: Date; reset_made_at: Date | null; reset_used_at: Date | null }>(
    `select m.user_id, u.email, m.role, m.created_at, r.created_at as reset_made_at, r.used_at as reset_used_at
     from memberships m
     join users u on u.id = m.user_id
     left join lateral (
       select created_at, used_at from sign_in_resets
       where user_id = m.user_id and (used_at is not null or expires_at > now())
       order by coalesce(used_at, created_at) desc limit 1
     ) r on true
     where m.account_id = $1 order by u.email`,
    [accountId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    role: r.role,
    joinedAt: r.created_at,
    ...(r.reset_made_at && { signInReset: { madeAt: r.reset_made_at, ...(r.reset_used_at && { usedAt: r.reset_used_at }) } }),
  }));
}

/**
 * Changes a member's role, or removes them (role undefined). Refuses to leave
 * the account without an admin. Returns "not-found", "last-admin" or "done".
 */
export async function changeMember(db: Db, accountId: string, userId: string, role: Role | undefined): Promise<"not-found" | "last-admin" | "done"> {
  return db.transaction(async (tx) => {
    // Lock the account's memberships so two admins can't demote each other at the same time.
    const { rows } = await tx.query<{ user_id: string; role: Role }>("select user_id, role from memberships where account_id = $1 for update", [accountId]);
    const member = rows.find((r) => r.user_id === userId);
    if (!member) return "not-found";
    const otherAdmins = rows.filter((r) => r.role === "admin" && r.user_id !== userId).length;
    if (member.role === "admin" && role !== "admin" && otherAdmins === 0) return "last-admin";
    if (role) await tx.query("update memberships set role = $3 where account_id = $1 and user_id = $2", [accountId, userId, role]);
    else {
      await tx.query("delete from memberships where account_id = $1 and user_id = $2", [accountId, userId]);
      // Their sessions in this account already stopped working (a session needs a membership); remove them too.
      await tx.query("delete from sessions where account_id = $1 and user_id = $2", [accountId, userId]);
    }
    return "done";
  });
}

// --- Invitations

const INVITATION_DAYS = 7;

interface InvitationRow {
  id: string;
  account_id: string;
  email: string;
  role: Role;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
}
const toInvitation = (r: InvitationRow): Invitation => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at });

/** A new invitation and its token. The token goes in the link and is not stored; show it once. */
export async function createInvitation(db: Queryable, input: { accountId: string; email: string; role: Role }): Promise<{ invitation: Invitation; token: string }> {
  const token = newToken();
  const { rows } = await db.query<InvitationRow>(
    `insert into invitations (account_id, email, role, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(days => $5)) returning *`,
    [input.accountId, input.email.toLowerCase(), input.role, hashToken(token), INVITATION_DAYS],
  );
  return { invitation: toInvitation(rows[0]), token };
}

/** A new account and the invitation for its first admin, both or neither. */
export async function createAccountWithAdmin(db: Db, name: string, email: string): Promise<{ account: Account; invitation: Invitation; token: string }> {
  return db.transaction(async (tx) => {
    const account = await createAccount(tx, name);
    return { account, ...(await createInvitation(tx, { accountId: account.id, email, role: "admin" })) };
  });
}

/** Open invitations of an account: not accepted and not expired. */
export async function listInvitations(db: Queryable, accountId: string): Promise<Invitation[]> {
  const { rows } = await db.query<InvitationRow>(
    "select * from invitations where account_id = $1 and accepted_at is null and expires_at > now() order by created_at",
    [accountId],
  );
  return rows.map(toInvitation);
}

export async function deleteInvitation(db: Queryable, accountId: string, id: string): Promise<boolean> {
  const { rows } = await db.query("delete from invitations where account_id = $1 and id = $2 and accepted_at is null returning id", [accountId, id]);
  return rows.length > 0;
}

/** The open invitation behind a link, with its account's name, or undefined when it is unknown, used or expired. */
export async function findOpenInvitation(db: Queryable, token: string): Promise<(Invitation & { account: Account }) | undefined> {
  const { rows } = await db.query<InvitationRow & { account_name: string }>(
    `select i.*, a.name as account_name from invitations i join accounts a on a.id = i.account_id
     where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  return r && { ...toInvitation(r), account: { id: r.account_id, name: r.account_name } };
}

/**
 * Keeps the authenticator secret the server made for a new user (sealed),
 * replacing any earlier one. False when the link is used or expired.
 */
export async function setInvitationTotpSecret(db: Queryable, token: string, sealedSecret: string): Promise<boolean> {
  const { rows } = await db.query(
    "update invitations set totp_secret = $2 where token_hash = $1 and accepted_at is null and expires_at > now() returning id",
    [hashToken(token), sealedSecret],
  );
  return rows.length === 1;
}

/** The sealed authenticator secret kept for an open invitation; undefined before the setup was opened. */
export async function invitationTotpSecret(db: Queryable, token: string): Promise<string | undefined> {
  const { rows } = await db.query<{ totp_secret: string | null }>(
    "select totp_secret from invitations where token_hash = $1 and accepted_at is null and expires_at > now()",
    [hashToken(token)],
  );
  return rows[0]?.totp_secret ?? undefined;
}

/**
 * Accepts an invitation: creates the user when `newUser` is given, adds the
 * membership and closes the invitation, all at once. Undefined when the
 * invitation was used or expired in the meantime. Someone who is already a
 * member keeps their role: an invitation never changes an existing role
 * (that goes through the Users and roles page, which keeps the last admin).
 */
export async function acceptInvitation(
  db: Db,
  token: string,
  user: { existingUserId: string } | { newUser: { passwordHash: string; totpSecret: string; totpStep: number } },
): Promise<{ userId: string; accountId: string } | undefined> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<InvitationRow>(
      "update invitations set accepted_at = now() where token_hash = $1 and accepted_at is null and expires_at > now() returning *",
      [hashToken(token)],
    );
    const invitation = rows[0];
    if (!invitation) return undefined;
    let userId: string;
    if ("existingUserId" in user) userId = user.existingUserId;
    else {
      const { passwordHash, totpSecret, totpStep } = user.newUser;
      const created = await tx.query<{ id: string }>(
        "insert into users (email, password_hash, totp_secret, totp_last_step) values ($1, $2, $3, $4) returning id",
        [invitation.email, passwordHash, totpSecret, totpStep],
      );
      userId = created.rows[0].id;
    }
    await tx.query(
      "insert into memberships (account_id, user_id, role) values ($1, $2, $3) on conflict (account_id, user_id) do nothing",
      [invitation.account_id, userId, invitation.role],
    );
    // Other open links for the same person and account have nothing left to do.
    await tx.query("delete from invitations where account_id = $1 and email = $2 and accepted_at is null", [invitation.account_id, invitation.email]);
    return { userId, accountId: invitation.account_id };
  });
}

// --- Sessions

export interface Session {
  userId: string;
  email: string;
  accountId: string;
  role: Role;
  /** The second factor (authenticator code) has been checked. */
  verified: boolean;
  /** Ystara's operator: may use the operator panel (migration 004). */
  operator: boolean;
}

/** Starts a session and returns the token for the cookie. */
export async function createSession(db: Queryable, input: { userId: string; accountId: string; verified: boolean; minutes: number }): Promise<string> {
  const token = newToken();
  await db.query(
    "insert into sessions (token_hash, user_id, account_id, verified, expires_at) values ($1, $2, $3, $4, now() + make_interval(mins => $5))",
    [hashToken(token), input.userId, input.accountId, input.verified, input.minutes],
  );
  return token;
}

/**
 * The live session behind a cookie, with the user's current role in its
 * account. Undefined when it expired or the user is no longer a member there.
 */
export async function findSession(db: Queryable, token: string): Promise<Session | undefined> {
  const { rows } = await db.query<{ user_id: string; email: string; account_id: string; role: Role; verified: boolean; operator: boolean }>(
    `select s.user_id, u.email, s.account_id, m.role, s.verified, u.operator
     from sessions s
     join users u on u.id = s.user_id
     join memberships m on m.account_id = s.account_id and m.user_id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  return r && { userId: r.user_id, email: r.email, accountId: r.account_id, role: r.role, verified: r.verified, operator: r.operator };
}

/** Moves a session to another account the user belongs to. False when they are not a member there. */
export async function switchSessionAccount(db: Queryable, token: string, accountId: string): Promise<boolean> {
  const { rows } = await db.query(
    `update sessions s set account_id = $2
     where s.token_hash = $1 and exists (select 1 from memberships m where m.account_id = $2 and m.user_id = s.user_id)
     returning s.user_id`,
    [hashToken(token), accountId],
  );
  return rows.length === 1;
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query("delete from sessions where token_hash = $1 or expires_at < now()", [hashToken(token)]);
}
