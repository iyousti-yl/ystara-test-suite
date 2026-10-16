import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptInvitation,
  changeMember,
  createAccount,
  createInvitation,
  createSession,
  deleteInvitation,
  deleteSession,
  findOpenInvitation,
  findSession,
  findUserByEmail,
  listInvitations,
  listMembers,
  membershipsOf,
  recordFailedCode,
  switchSessionAccount,
  useTotpStep,
} from "./accounts.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { createTenant, listTenants } from "./tenants.js";
import { createTestDb } from "./testing.js";

// Hashes and secrets are opaque text to the database; apps/api makes the real ones.
const newUser = (n: number) => ({ newUser: { passwordHash: `hash-${n}`, totpSecret: `sealed-${n}`, totpStep: 0 } });

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

/** A new account whose first admin accepted their invitation. */
async function accountWithAdmin(name: string, email: string) {
  const account = await createAccount(db, name);
  const { token } = await createInvitation(db, { accountId: account.id, email, role: "admin" });
  const joined = await acceptInvitation(db, token, newUser(1));
  return { account, adminId: joined!.userId };
}

describe("invitations", () => {
  it("create the user and their membership once, and only their hash is stored", async () => {
    const account = await createAccount(db, "Invites");
    const { invitation, token } = await createInvitation(db, { accountId: account.id, email: "New.Person@Example.com", role: "developer" });
    expect(invitation.email).toBe("new.person@example.com");
    expect((await db.query("select * from invitations where token_hash = $1", [token])).rows).toEqual([]);
    expect(await findOpenInvitation(db, token)).toMatchObject({ email: "new.person@example.com", role: "developer", account: { name: "Invites" } });
    expect((await listInvitations(db, account.id)).map((i) => i.id)).toEqual([invitation.id]);

    const joined = await acceptInvitation(db, token, newUser(2));
    expect(joined?.accountId).toBe(account.id);
    expect(await findUserByEmail(db, "NEW.person@example.com")).toMatchObject({ id: joined!.userId, passwordHash: "hash-2", totpSecret: "sealed-2" });
    expect((await listMembers(db, account.id)).map((m) => [m.email, m.role])).toEqual([["new.person@example.com", "developer"]]);

    // Used once: the link is closed now.
    expect(await findOpenInvitation(db, token)).toBeUndefined();
    expect(await acceptInvitation(db, token, newUser(3))).toBeUndefined();
    expect(await listInvitations(db, account.id)).toEqual([]);
  });

  it("close the other open links for the same person once one is accepted", async () => {
    const account = await createAccount(db, "Twice invited");
    const first = await createInvitation(db, { accountId: account.id, email: "twice@example.com", role: "viewer" });
    const second = await createInvitation(db, { accountId: account.id, email: "twice@example.com", role: "developer" });
    await acceptInvitation(db, second.token, newUser(7));
    expect(await findOpenInvitation(db, first.token)).toBeUndefined();
    expect(await listInvitations(db, account.id)).toEqual([]);
  });

  it("add an existing user to another account, with the role of the invitation", async () => {
    const first = await accountWithAdmin("First", "consultant@example.com");
    const second = await createAccount(db, "Second");
    const { token } = await createInvitation(db, { accountId: second.id, email: "consultant@example.com", role: "viewer" });
    expect(await acceptInvitation(db, token, { existingUserId: first.adminId })).toEqual({ userId: first.adminId, accountId: second.id });
    expect((await membershipsOf(db, first.adminId)).map((a) => [a.name, a.role])).toEqual([
      ["First", "admin"],
      ["Second", "viewer"],
    ]);
  });

  it("expire, and can be withdrawn by their own account only", async () => {
    const { account } = await accountWithAdmin("Withdraws", "admin@withdraws.example.com");
    const other = await createAccount(db, "Someone else");
    const { invitation, token } = await createInvitation(db, { accountId: account.id, email: "late@example.com", role: "viewer" });
    expect(await deleteInvitation(db, other.id, invitation.id)).toBe(false);
    expect(await deleteInvitation(db, account.id, invitation.id)).toBe(true);
    expect(await findOpenInvitation(db, token)).toBeUndefined();

    const old = await createInvitation(db, { accountId: account.id, email: "old@example.com", role: "viewer" });
    await db.query("update invitations set expires_at = now() - interval '1 second' where id = $1", [old.invitation.id]);
    expect(await findOpenInvitation(db, old.token)).toBeUndefined();
    expect(await acceptInvitation(db, old.token, newUser(4))).toBeUndefined();
  });
});

describe("members", () => {
  it("change roles and leave, but an account always keeps an admin", async () => {
    const { account, adminId } = await accountWithAdmin("Keeps an admin", "only-admin@example.com");
    expect(await changeMember(db, account.id, adminId, "viewer")).toBe("last-admin");
    expect(await changeMember(db, account.id, adminId, undefined)).toBe("last-admin");

    const { token } = await createInvitation(db, { accountId: account.id, email: "second@example.com", role: "developer" });
    const second = (await acceptInvitation(db, token, newUser(5)))!.userId;
    expect(await changeMember(db, account.id, second, "admin")).toBe("done");
    expect(await changeMember(db, account.id, adminId, "viewer")).toBe("done");
    expect(await changeMember(db, account.id, second, undefined)).toBe("last-admin");
    expect(await changeMember(db, account.id, adminId, undefined)).toBe("done");
    expect((await listMembers(db, account.id)).map((m) => [m.email, m.role])).toEqual([["second@example.com", "admin"]]);
    expect(await changeMember(db, account.id, adminId, "admin")).toBe("not-found");
  });
});

describe("sessions", () => {
  it("are found by their token only while live, with the user's current role", async () => {
    const { account, adminId } = await accountWithAdmin("Sessions", "session@example.com");
    const token = await createSession(db, { userId: adminId, accountId: account.id, verified: true, minutes: 60 });
    expect((await db.query("select * from sessions where token_hash = $1", [token])).rows).toEqual([]);
    expect(await findSession(db, token)).toEqual({ userId: adminId, email: "session@example.com", accountId: account.id, role: "admin", verified: true });

    await deleteSession(db, token);
    expect(await findSession(db, token)).toBeUndefined();

    const expired = await createSession(db, { userId: adminId, accountId: account.id, verified: true, minutes: -1 });
    expect(await findSession(db, expired)).toBeUndefined();
  });

  it("end when the user leaves the account, and switch only to the user's own accounts", async () => {
    const { account } = await accountWithAdmin("Leaving", "boss@leaving.example.com");
    const { token: invite } = await createInvitation(db, { accountId: account.id, email: "leaver@example.com", role: "developer" });
    const leaver = (await acceptInvitation(db, invite, newUser(6)))!.userId;
    const token = await createSession(db, { userId: leaver, accountId: account.id, verified: true, minutes: 60 });

    const elsewhere = await createAccount(db, "Not theirs");
    expect(await switchSessionAccount(db, token, elsewhere.id)).toBe(false);
    expect((await findSession(db, token))?.accountId).toBe(account.id);

    expect(await changeMember(db, account.id, leaver, undefined)).toBe("done");
    expect(await findSession(db, token)).toBeUndefined();
  });

  it("count wrong codes", async () => {
    const { account, adminId } = await accountWithAdmin("Wrong codes", "codes@example.com");
    const token = await createSession(db, { userId: adminId, accountId: account.id, verified: false, minutes: 10 });
    expect(await recordFailedCode(db, token)).toBe(1);
    expect(await recordFailedCode(db, token)).toBe(2);
  });
});

describe("authenticator codes", () => {
  it("work once each: a used code, or an older one, is refused", async () => {
    const { adminId } = await accountWithAdmin("Codes once", "once@example.com");
    expect(await useTotpStep(db, adminId, 1000)).toBe(true);
    expect(await useTotpStep(db, adminId, 1000)).toBe(false);
    expect(await useTotpStep(db, adminId, 999)).toBe(false);
    expect(await useTotpStep(db, adminId, 1001)).toBe(true);
  });
});

describe("migration 003", () => {
  it("moves tenants from before sign-in into an account named Default", async () => {
    const old = await createTestDb({ migrated: false });
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    await old.exec("create table schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const file of ["001_discovery.sql", "002_clears_edges.sql"]) {
      await old.exec(await readFile(`${dir}${file}`, "utf8"));
      await old.query("insert into schema_migrations (name) values ($1)", [file]);
    }
    await old.query("insert into tenants (name, host) values ('Imported', null)");

    expect(await migrate(old)).toContain("003_accounts.sql");
    const { rows } = await old.query<{ id: string }>("select id from accounts where name = 'Default'");
    expect((await listTenants(old, rows[0].id)).map((t) => t.name)).toEqual(["Imported"]);
    await expect(createTenant(old, { accountId: rows[0].id, name: "Imported", host: null })).rejects.toThrow();
    await old.close();
  });
});
