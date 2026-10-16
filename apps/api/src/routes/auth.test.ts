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

  it("locks codes for the user after five wrong ones, also across new sign-ins", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "guess@example.com", role: "viewer" });
    const signIn = async () => sessionCookie(await call("POST", "/auth/login", { payload: { email: "guess@example.com", password: TEST_PASSWORD } }));
    const tryCode = (cookie: string, code: string) => call("POST", "/auth/code", { cookie, payload: { code } });

    const first = await signIn();
    for (let i = 0; i < 4; i++) expect((await tryCode(first.header, "000000")).json()).toMatchObject({ error: expect.stringMatching(/not right/) });
    const locked = await tryCode(first.header, "000000");
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: "Too many wrong codes. Wait a minute, then sign in again.", restart: true });
    // The sign-in is over: its cookie opens nothing any more.
    expect((await tryCode(first.header, codeNow(user.totpSecret))).statusCode).toBe(401);

    // A new sign-in with the password doesn't reset the count: even the right code waits.
    const second = await signIn();
    expect((await tryCode(second.header, codeNow(user.totpSecret))).statusCode).toBe(429);

    // Once the wait is over, the right code works and the count starts again.
    await db.query("update users set codes_locked_until = now() - interval '1 second' where id = $1", [user.userId]);
    const third = await signIn();
    expect((await tryCode(third.header, codeNow(user.totpSecret))).statusCode).toBe(200);
    const { rows } = await db.query<{ failed_codes: number }>("select failed_codes from users where id = $1", [user.userId]);
    expect(rows[0].failed_codes).toBe(0);
  });

  it("checks no more than five codes when many are sent at once", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "at.once@example.com", role: "viewer" });
    const pending = sessionCookie(await call("POST", "/auth/login", { payload: { email: "at.once@example.com", password: TEST_PASSWORD } }));
    const answers = await Promise.all(Array.from({ length: 9 }, () => call("POST", "/auth/code", { cookie: pending.header, payload: { code: "000000" } })));
    expect(answers.filter((a) => a.statusCode === 401 && /not right/.test(a.json().error))).toHaveLength(4);
    const { rows } = await db.query<{ failed_codes: number }>("select failed_codes from users where id = $1", [user.userId]);
    expect(rows[0].failed_codes).toBe(5);
  });

  it("ends with signing out", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "leaves@example.com", role: "viewer" });
    expect((await call("GET", "/auth/me", { cookie: user.cookie })).statusCode).toBe(200);
    expect((await call("POST", "/auth/logout", { cookie: user.cookie })).statusCode).toBe(204);
    expect((await call("GET", "/auth/me", { cookie: user.cookie })).statusCode).toBe(401);
  });

  it("refuses changes sent from another site", async () => {
    const user = await testUser(db, { account: "Sign-in", email: "csrf@example.com", role: "admin" });
    const payload = { name: "From elsewhere", host: "https://synthetic.eu10.hcs.cloud.sap" };
    const elsewhere = await call("POST", "/tenants", { cookie: user.cookie, payload, origin: "https://evil.example.com" });
    expect(elsewhere.statusCode).toBe(403);
    expect((await call("POST", "/tenants", { cookie: user.cookie, payload, origin: "http://localhost" })).statusCode).toBe(201);
  });
});

describe("invitation links", () => {
  it("let a new user choose a password and set up the authenticator app, once", async () => {
    const account = await createAccount(db, "Joining");
    const { token } = await createInvitation(db, { accountId: account.id, email: "new@example.com", role: "test_coordinator" });
    const accept = (payload: object) => call("POST", `/invitations/${token}/accept`, { payload });

    expect((await call("GET", `/invitations/${token}`)).json()).toEqual({ account: "Joining", email: "new@example.com", role: "test_coordinator", existingUser: false });
    expect((await accept({ password: "a fine long password", code: "123456" })).json().error).toMatch(/Set up the authenticator app first/);

    // Opening the setup again makes a new secret: codes from the first one no longer count.
    const replaced = (await call("POST", `/invitations/${token}/authenticator`)).json();
    const setup = (await call("POST", `/invitations/${token}/authenticator`)).json();
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    expect(setup.secret).not.toBe(replaced.secret);
    expect((await accept({ password: "a fine long password", code: codeNow(replaced.secret) })).json().error).toMatch(/code is not right/);

    expect((await accept({ password: "too short", code: codeNow(setup.secret) })).json().error).toMatch(/at least 12/);
    expect((await accept({ password: "a fine long password", code: "123456" })).json().error).toMatch(/code is not right/);
    const joined = await accept({ password: "a fine long password", code: codeNow(setup.secret) });
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ user: { email: "new@example.com" }, account: { name: "Joining" }, role: "test_coordinator" });
    expect((await call("GET", "/tenants", { cookie: sessionCookie(joined).header })).statusCode).toBe(200);

    // The authenticator secret is the one the server made, stored encrypted.
    const { rows } = await db.query<{ totp_secret: string }>("select totp_secret from users where email = 'new@example.com'");
    expect(rows[0].totp_secret).not.toContain(setup.secret);
    expect(testSecrets.open(rows[0].totp_secret)).toBe(setup.secret);

    expect((await call("GET", `/invitations/${token}`)).statusCode).toBe(404);
    expect((await accept({ password: "a fine long password", code: codeNow(setup.secret) })).statusCode).toBe(404);
  });

  it("never take an authenticator secret from the browser", async () => {
    const account = await createAccount(db, "Own secret");
    const { token } = await createInvitation(db, { accountId: account.id, email: "chooser@example.com", role: "viewer" });
    await call("POST", `/invitations/${token}/authenticator`);
    const chosen = "A".repeat(32);
    const res = await call("POST", `/invitations/${token}/accept`, { payload: { password: "a fine long password", totpSecret: chosen, code: codeNow(chosen) } });
    expect(res.statusCode).toBe(400);
    expect((await call("GET", `/invitations/${token}`)).statusCode).toBe(200); // still open
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
  const fresh = () => buildServer({ db, queue: { send: async () => undefined }, secrets: testSecrets }, { logger: false });

  it("is slowed down: ten tries a minute per link", async () => {
    const limited = await fresh();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await limited.inject(`/api/invitations/${"x".repeat(43)}`)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await limited.inject(`/api/invitations/${"y".repeat(43)}`)).statusCode).toBe(404); // another link isn't blocked
    await limited.close();
  });

  it("of one email's password doesn't block others who share the address", async () => {
    // Real users: their (cheap test) hashes keep this quick, where an unknown email costs a full one.
    await testUser(db, { account: "Sign-in", email: "target@example.com", role: "viewer" });
    await testUser(db, { account: "Sign-in", email: "colleague@example.com", role: "viewer" });
    const limited = await fresh();
    const login = (email: string) => limited.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong password!" } });
    for (let i = 0; i < 10; i++) expect((await login("target@example.com")).statusCode).toBe(401);
    expect((await login(" TARGET@example.com")).statusCode).toBe(429);
    expect((await login("colleague@example.com")).statusCode).toBe(401);
    await limited.close();
  });
});
