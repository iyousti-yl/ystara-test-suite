import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createAccount, createInvitation, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { Me } from "@ystara/shared";
import { TEST_PASSWORD, testSecrets, testUser } from "../auth/testing.js";
import { totpCode, totpStep } from "../auth/totp.js";
import { buildServer } from "../server.js";

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async () => undefined }, secrets: testSecrets }, { logger: false });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST", url: string, opts: { payload?: object; cookie?: string; origin?: string } = {}) =>
  app.inject({
    method,
    url: `/api${url}`,
    payload: opts.payload,
    headers: { ...(opts.cookie && { cookie: opts.cookie }), ...(opts.origin && { origin: opts.origin }) },
  });

/** The session cookie a response sets, as a Cookie header, plus its attributes. */
function sessionCookie(res: LightMyRequestResponse) {
  const set = res.cookies.find((c) => c.name === "ystara_session")!;
  return { header: `ystara_session=${set.value}`, ...set };
}

const codeNow = (secret: string) => totpCode(secret, totpStep());

describe("signing in", () => {
  it("takes the password, then a code from the authenticator app", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "anna@example.com", role: "developer" });

    expect((await call("POST", "/auth/login", { payload: { email: "anna@example.com", password: "wrong password!" } })).json().error).toBe(
      "The email or password is not right",
    );
    expect((await call("POST", "/auth/login", { payload: { email: "nobody@example.com", password: TEST_PASSWORD } })).json().error).toBe(
      "The email or password is not right",
    );

    const login = await call("POST", "/auth/login", { payload: { email: " Anna@Example.com ", password: TEST_PASSWORD } });
    expect(login.json()).toEqual({ next: "code" });
    const pending = sessionCookie(login);
    expect(pending).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api", maxAge: 600 });

    // The password alone opens nothing.
    expect((await call("GET", "/auth/me", { cookie: pending.header })).statusCode).toBe(401);
    expect((await call("GET", "/tenants", { cookie: pending.header })).statusCode).toBe(401);

    expect((await call("POST", "/auth/code", { cookie: pending.header, payload: { code: "000000" } })).statusCode).toBe(401);
    const verified = await call("POST", "/auth/code", { cookie: pending.header, payload: { code: codeNow(user.totpSecret) } });
    expect(verified.statusCode).toBe(200);
    const me: Me = verified.json();
    expect(me).toMatchObject({ user: { email: "anna@example.com" }, account: { name: "Sign-in" }, role: "developer" });
    expect(me.permissions).toContain("discovery.run");
    expect(me.permissions).not.toContain("users.manage");

    // A new token after the code: the one from before it is worthless.
    const session = sessionCookie(verified);
    expect(session.value).not.toBe(pending.value);
    expect(session.maxAge).toBe(12 * 60 * 60);
    expect((await call("GET", "/auth/me", { cookie: pending.header })).statusCode).toBe(401);
    expect((await call("GET", "/tenants", { cookie: session.header })).statusCode).toBe(200);

    // Each code works once.
    const again = sessionCookie(await call("POST", "/auth/login", { payload: { email: "anna@example.com", password: TEST_PASSWORD } }));
    expect((await call("POST", "/auth/code", { cookie: again.header, payload: { code: codeNow(user.totpSecret) } })).json().error).toMatch(/already used/);
  });

  it("asks for the password again after five wrong codes", async () => {
    await testUser(db, { account: "Sign-in", email: "guess@example.com", role: "viewer" });
    const pending = sessionCookie(await call("POST", "/auth/login", { payload: { email: "guess@example.com", password: TEST_PASSWORD } }));
    for (let i = 0; i < 4; i++) expect((await call("POST", "/auth/code", { cookie: pending.header, payload: { code: "000000" } })).json().restart).toBeUndefined();
    expect((await call("POST", "/auth/code", { cookie: pending.header, payload: { code: "000000" } })).json().restart).toBe(true);
    expect((await call("POST", "/auth/code", { cookie: pending.header, payload: { code: "000000" } })).statusCode).toBe(401);
  });

  it("ends with signing out", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "leaves@example.com", role: "viewer" });
    expect((await call("GET", "/auth/me", { cookie: user.cookie })).statusCode).toBe(200);
    expect((await call("POST", "/auth/logout", { cookie: user.cookie })).statusCode).toBe(204);
    expect((await call("GET", "/auth/me", { cookie: user.cookie })).statusCode).toBe(401);
  });

  it("refuses changes sent from another site", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "csrf@example.com", role: "admin" });
    const payload = { name: "From elsewhere", host: "https://x.example.com" };
    const elsewhere = await call("POST", "/tenants", { cookie: user.cookie, payload, origin: "https://evil.example.com" });
    expect(elsewhere.statusCode).toBe(403);
    expect((await call("POST", "/tenants", { cookie: user.cookie, payload, origin: "http://localhost" })).statusCode).toBe(201);
  });
});

describe("invitation links", () => {
  it("let a new user choose a password and set up the authenticator app, once", async () => {
    const account = await createAccount(db, "Joining");
    const { token } = await createInvitation(db, { accountId: account.id, email: "new@example.com", role: "test_coordinator" });

    expect((await call("GET", `/invitations/${token}`)).json()).toEqual({ account: "Joining", email: "new@example.com", role: "test_coordinator", existingUser: false });
    const setup = (await call("POST", `/invitations/${token}/authenticator`)).json();
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);

    const accept = (payload: object) => call("POST", `/invitations/${token}/accept`, { payload });
    expect((await accept({ password: "too short", totpSecret: setup.secret, code: codeNow(setup.secret) })).json().error).toMatch(/at least 12/);
    expect((await accept({ password: "a fine long password", totpSecret: setup.secret, code: "123456" })).json().error).toMatch(/code is not right/);
    const joined = await accept({ password: "a fine long password", totpSecret: setup.secret, code: codeNow(setup.secret) });
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ user: { email: "new@example.com" }, account: { name: "Joining" }, role: "test_coordinator" });
    expect((await call("GET", "/tenants", { cookie: sessionCookie(joined).header })).statusCode).toBe(200);

    // The authenticator secret is stored encrypted.
    const { rows } = await db.query<{ totp_secret: string }>("select totp_secret from users where email = 'new@example.com'");
    expect(rows[0].totp_secret).not.toContain(setup.secret);
    expect(testSecrets.open(rows[0].totp_secret)).toBe(setup.secret);

    expect((await call("GET", `/invitations/${token}`)).statusCode).toBe(404);
    expect((await accept({ password: "a fine long password", totpSecret: setup.secret, code: codeNow(setup.secret) })).statusCode).toBe(404);
  });

  it("let an existing user join another account after signing in as that email", async () => {
    const consultant = await testUser(db, { account: "Customer one", email: "consultant@example.com", role: "developer" });
    const stranger = await testUser(db, { account: "Customer one", email: "stranger@example.com", role: "developer" });
    const two = await createAccount(db, "Customer two");
    const { token } = await createInvitation(db, { accountId: two.id, email: "consultant@example.com", role: "viewer" });

    expect((await call("GET", `/invitations/${token}`)).json().existingUser).toBe(true);
    expect((await call("POST", `/invitations/${token}/authenticator`)).statusCode).toBe(409);
    expect((await call("POST", `/invitations/${token}/accept`, { payload: {} })).json().error).toMatch(/Sign in as consultant@example.com/);
    expect((await call("POST", `/invitations/${token}/accept`, { payload: {}, cookie: stranger.cookie })).statusCode).toBe(401);

    const joined = await call("POST", `/invitations/${token}/accept`, { payload: {}, cookie: consultant.cookie });
    expect(joined.json()).toMatchObject({ account: { name: "Customer two" }, role: "viewer" });
    expect(joined.json().accounts.map((a: { name: string; role: string }) => `${a.name}: ${a.role}`)).toEqual(["Customer one: developer", "Customer two: viewer"]);

    // Switching back to the first account, and not into someone else's.
    const back = await call("POST", "/auth/account", { cookie: consultant.cookie, payload: { accountId: consultant.accountId } });
    expect(back.json()).toMatchObject({ account: { name: "Customer one" }, role: "developer" });
    const other = await createAccount(db, "Not theirs");
    expect((await call("POST", "/auth/account", { cookie: consultant.cookie, payload: { accountId: other.id } })).statusCode).toBe(404);
  });

  it("answer the same for an unknown link as for a used one", async () => {
    expect((await call("GET", `/invitations/${"x".repeat(43)}`)).json().error).toMatch(/no longer valid/);
    expect((await call("GET", "/invitations/short")).statusCode).toBe(400);
  });
});

describe("guessing", () => {
  it("is slowed down: ten tries a minute", async () => {
    const limited = await buildServer({ db, queue: { send: async () => undefined }, secrets: testSecrets }, { logger: false });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await limited.inject(`/api/invitations/${"x".repeat(43)}`)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    await limited.close();
  });
});
