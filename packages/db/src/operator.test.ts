import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvitation, createAccount, createAccountWithAdmin, createInvitation, createSession, findOpenInvitation, findSession, getUser, listMembers } from "./accounts.js";
import type { Db } from "./db.js";
import {
  createSignInReset,
  findOpenSignInReset,
  inviteAdminWhereNoneLeft,
  listAccountOverviews,
  listUserOverviews,
  setOperator,
  setSignInResetTotpSecret,
  signInResetTotpSecret,
  useSignInReset,
} from "./operator.js";
import { createTenant } from "./tenants.js";
import { createTestDb } from "./testing.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function member(account: { id: string }, email: string, role: "admin" | "viewer") {
  const { token } = await createInvitation(db, { accountId: account.id, email, role });
  const existing = (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows[0];
  const joined = await acceptInvitation(db, token, existing ? { existingUserId: existing.id } : { newUser: { passwordHash: "old-hash", totpSecret: "old-secret", totpStep: 0 } });
  return joined!.userId;
}

describe("the operator panel's overview", () => {
  it("counts each account's members, admins, tenants and open invitations", async () => {
    const north = await createAccount(db, "North");
    const south = await createAccount(db, "South");
    await member(north, "boss@north.example.com", "admin");
    await member(north, "reader@north.example.com", "viewer");
    await member(south, "boss@north.example.com", "viewer");
    await createTenant(db, { accountId: north.id, name: "Production", host: null });
    await createInvitation(db, { accountId: south.id, email: "late@south.example.com", role: "admin" });

    expect((await listAccountOverviews(db)).map(({ name, members, admins, tenants, openInvitations }) => ({ name, members, admins, tenants, openInvitations }))).toEqual([
      { name: "North", members: 2, admins: 1, tenants: 1, openInvitations: 0 },
      { name: "South", members: 1, admins: 0, tenants: 0, openInvitations: 1 },
    ]);
    const boss = (await listUserOverviews(db)).find((u) => u.email === "boss@north.example.com")!;
    expect(boss.accounts.map((a) => `${a.name}: ${a.role}`)).toEqual(["North: admin", "South: viewer"]);
  });

  it("is open to users with the operator flag, which only setOperator changes", async () => {
    const account = await createAccount(db, "Operator's own");
    const userId = await member(account, "ops@example.com", "admin");
    const token = await createSession(db, { userId, accountId: account.id, verified: true, minutes: 60 });
    expect((await findSession(db, token))?.operator).toBe(false);
    expect(await setOperator(db, "OPS@example.com", true)).toBe(true);
    expect((await findSession(db, token))?.operator).toBe(true);
    expect(await setOperator(db, "nobody@example.com", true)).toBe(false);
  });
});

describe("reset links", () => {
  it("replace the password and authenticator once, and end every session", async () => {
    const account = await createAccount(db, "Lost phone");
    const opsId = await member(account, "ops@lost.example.com", "viewer");
    const userId = await member(account, "lost@example.com", "admin");
    const session = await createSession(db, { userId, accountId: account.id, verified: true, minutes: 60 });

    const first = (await createSignInReset(db, userId, opsId)) as { token: string };
    const second = (await createSignInReset(db, userId, opsId)) as { token: string };
    expect(await findOpenSignInReset(db, first.token)).toBeUndefined(); // only the newest link works
    expect(await findOpenSignInReset(db, second.token)).toEqual({ userId, email: "lost@example.com" });
    expect((await db.query("select * from sign_in_resets where token_hash = $1", [second.token])).rows).toEqual([]);
    expect(await setSignInResetTotpSecret(db, first.token, "sealed-old")).toBe(false);
    expect(await setSignInResetTotpSecret(db, second.token, "sealed-new")).toBe(true);
    expect(await signInResetTotpSecret(db, second.token)).toBe("sealed-new");

    // Wrong codes before the reset are forgotten with it.
    await db.query("update users set failed_codes = 7, codes_locked_until = now() + interval '1 hour' where id = $1", [userId]);
    expect(await useSignInReset(db, second.token, { passwordHash: "new-hash", totpSecret: "new-secret", totpStep: 5 })).toBe(userId);
    expect(await getUser(db, userId)).toMatchObject({ passwordHash: "new-hash", totpSecret: "new-secret", codesLockedUntil: null });
    expect(await findSession(db, session)).toBeUndefined();
    expect(await useSignInReset(db, second.token, { passwordHash: "again", totpSecret: "again", totpStep: 6 })).toBeUndefined();
    expect(await createSignInReset(db, "00000000-0000-4000-8000-000000000000", opsId)).toBe("not-found");

    // Both links stay on record, with who made them.
    const { rows } = await db.query<{ created_by: string; used: boolean }>("select created_by, used_at is not null as used from sign_in_resets where user_id = $1 order by created_at", [userId]);
    expect(rows).toEqual([
      { created_by: opsId, used: false },
      { created_by: opsId, used: true },
    ]);
  });

  it("are shown to the user's account admins, open or used", async () => {
    const account = await createAccount(db, "Sees resets");
    const opsId = await member(account, "ops@sees.example.com", "viewer");
    const userId = await member(account, "reset.me@example.com", "viewer");
    const resetOf = async () => (await listMembers(db, account.id)).find((m) => m.userId === userId)!.signInReset;
    expect(await resetOf()).toBeUndefined();

    const { token } = (await createSignInReset(db, userId, opsId)) as { token: string };
    expect(await resetOf()).toEqual({ madeAt: expect.any(Date) });
    await useSignInReset(db, token, { passwordHash: "h", totpSecret: "s", totpStep: 1 });
    expect(await resetOf()).toEqual({ madeAt: expect.any(Date), usedAt: expect.any(Date) });
  });

  it("can't be made for an operator", async () => {
    const account = await createAccount(db, "Two operators");
    const one = await member(account, "one@ops.example.com", "admin");
    const two = await member(account, "two@ops.example.com", "admin");
    await setOperator(db, "two@ops.example.com", true);
    expect(await createSignInReset(db, two, one)).toBe("operator");
    expect((await db.query("select 1 from sign_in_resets where user_id = $1", [two])).rows).toEqual([]);
  });
});

describe("a new admin from the operator", () => {
  it("is only invited to an account with no admin left", async () => {
    const { account, token } = await createAccountWithAdmin(db, "Admin gone", "first@gone.example.com");
    expect(await findOpenInvitation(db, token)).toMatchObject({ email: "first@gone.example.com", role: "admin", account: { name: "Admin gone" } });

    // No admin yet (the first one hasn't accepted): another invitation is fine.
    const again = await inviteAdminWhereNoneLeft(db, account.id, "second@gone.example.com");
    expect(again).toMatchObject({ invitation: { role: "admin" } });

    await acceptInvitation(db, token, { newUser: { passwordHash: "h", totpSecret: "s", totpStep: 0 } });
    expect(await inviteAdminWhereNoneLeft(db, account.id, "ops@example.com")).toBe("has-admin");
    expect(await inviteAdminWhereNoneLeft(db, "00000000-0000-4000-8000-000000000000", "x@example.com")).toBe("not-found");
  });
});
