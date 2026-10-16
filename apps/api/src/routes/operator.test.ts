import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { AccountOverview, Member, UserOverview } from "@ystara/shared";
import { TEST_PASSWORD, testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { totpCode, totpStep } from "../auth/totp.js";
import { buildServer } from "../server.js";

let db: Db;
let app: FastifyInstance;
let ops: TestUser;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async () => undefined }, secrets: testSecrets }, { logger: false });
  ops = await testUser(db, { account: "Ystara", email: "ops@ystara.example.com", role: "admin", operator: true });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST", url: string, opts: { payload?: object; as?: TestUser; cookie?: string } = {}) =>
  app.inject({ method, url: `/api${url}`, payload: opts.payload, headers: { cookie: opts.cookie ?? (opts.as ?? ops).cookie } });

describe("the operator panel", () => {
  it("is for the operator only, not for an account's admin", async () => {
    const admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
    for (const url of ["/operator/accounts", "/operator/users"]) expect((await call("GET", url, { as: admin })).statusCode, url).toBe(403);
    expect((await call("POST", "/operator/accounts", { as: admin, payload: { name: "Mine", adminEmail: "x@example.com" } })).statusCode).toBe(403);
    expect((await call("GET", "/auth/me", { as: admin })).json().operator).toBe(false);
    expect((await call("GET", "/auth/me")).json().operator).toBe(true);
  });

  it("creates an account with an invitation link for its first admin", async () => {
    const res = await call("POST", "/operator/accounts", { payload: { name: "New customer", adminEmail: "First.Admin@new.example.com" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ account: { name: "New customer" }, invitation: { email: "first.admin@new.example.com", role: "admin" } });
    expect((await call("GET", `/invitations/${res.json().token}`)).json()).toMatchObject({ account: "New customer", role: "admin" });
    expect((await call("POST", "/operator/accounts", { payload: { name: "New customer", adminEmail: "other@example.com" } })).statusCode).toBe(409);

    const overview: AccountOverview[] = (await call("GET", "/operator/accounts")).json();
    expect(overview.find((a) => a.name === "New customer")).toMatchObject({ members: 0, admins: 0, tenants: 0, openInvitations: 1 });

    const again = await call("POST", `/operator/accounts/${res.json().account.id}/invitations`, { payload: { email: "second.admin@new.example.com" } });
    expect(again.json().invitation).toMatchObject({ role: "admin" });
    expect((await call("POST", "/operator/accounts/00000000-0000-4000-8000-000000000000/invitations", { payload: { email: "x@example.com" } })).statusCode).toBe(404);
  });

  it("can't make the operator admin of an account that still has one", async () => {
    const admin = await testUser(db, { account: "Has an admin", email: "admin@has.example.com", role: "admin" });
    const res = await call("POST", `/operator/accounts/${admin.accountId}/invitations`, { payload: { email: ops.email } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/still has an admin/);
  });

  it("can't reset another operator's sign-in", async () => {
    const other = await testUser(db, { account: "Ystara", email: "ops2@ystara.example.com", role: "viewer", operator: true });
    expect((await call("POST", `/operator/users/${other.userId}/reset`)).statusCode).toBe(409);
    expect((await call("POST", `/operator/users/${ops.userId}/reset`)).statusCode).toBe(409);
  });

  it("lists users with their accounts and makes reset links that work once", async () => {
    const lost = await testUser(db, { account: "Customer", email: "lost.phone@customer.example.com", role: "developer" });
    const users: UserOverview[] = (await call("GET", "/operator/users")).json();
    expect(users.find((u) => u.id === lost.userId)?.accounts.map((a) => `${a.name}: ${a.role}`)).toEqual(["Customer: developer"]);

    const admin = await testUser(db, { account: "Customer", email: "admin.sees@customer.example.com", role: "admin" });
    const resetSeen = async () => ((await call("GET", "/team", { as: admin })).json().members as Member[]).find((m) => m.userId === lost.userId)?.signInReset;
    expect(await resetSeen()).toBeUndefined();

    const { token } = (await call("POST", `/operator/users/${lost.userId}/reset`)).json();
    expect(await resetSeen()).toEqual({ madeAt: expect.any(String) });
    expect((await call("GET", `/resets/${token}`, { cookie: "" })).json()).toEqual({ email: "lost.phone@customer.example.com" });
    const accept = (payload: object) => call("POST", `/resets/${token}/accept`, { cookie: "", payload });
    expect((await accept({ password: "a brand new password", code: "123456" })).json().error).toMatch(/Set up the authenticator app first/);
    const setup = (await call("POST", `/resets/${token}/authenticator`, { cookie: "" })).json();
    expect((await accept({ password: "short", code: totpCode(setup.secret, totpStep()) })).statusCode).toBe(400);
    // A secret chosen by the browser counts for nothing.
    const chosen = "A".repeat(32);
    expect((await accept({ password: "a brand new password", totpSecret: chosen, code: totpCode(chosen, totpStep()) })).json().error).toMatch(/code is not right/);
    const done = await accept({ password: "a brand new password", code: totpCode(setup.secret, totpStep()) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ user: { email: "lost.phone@customer.example.com" }, account: { name: "Customer" }, role: "developer" });

    // The old sign-in ended, the old password no longer works, the new one does, and the link is used up.
    expect((await call("GET", "/auth/me", { as: lost })).statusCode).toBe(401);
    expect((await call("POST", "/auth/login", { cookie: "", payload: { email: lost.email, password: TEST_PASSWORD } })).statusCode).toBe(401);
    expect((await call("POST", "/auth/login", { cookie: "", payload: { email: lost.email, password: "a brand new password" } })).statusCode).toBe(200);
    expect((await call("GET", `/resets/${token}`, { cookie: "" })).statusCode).toBe(404);
    expect(await resetSeen()).toEqual({ madeAt: expect.any(String), usedAt: expect.any(String) });
  });
});
