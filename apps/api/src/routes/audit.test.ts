import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { recordAuditEvent, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { AUDIT_ACTIONS, type AuditEvent, type AuditPage } from "@ystara/shared";
import { installAudit } from "../audit.js";
import { TEST_PASSWORD, testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { totpCode, totpStep } from "../auth/totp.js";
import { buildServer } from "../server.js";

const WEBHOOK = "https://default0a1b.2c.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SECRET";
const client = {
  clientId: "sb-synthetic-client",
  clientSecret: "synthetic-secret-value",
  tokenUrl: "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token",
  spaces: ["SALES"],
};

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
let developer: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async () => {} }, secrets: testSecrets, teams: async () => {} }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
  developer = await testUser(db, { account: "Customer", email: "developer@customer.example.com", role: "developer" });
  stranger = await testUser(db, { account: "Elsewhere", email: "admin@elsewhere.example.com", role: "admin" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, as?: TestUser, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: as ? { cookie: as.cookie } : {}, payload });
const log = async (as: TestUser, query = ""): Promise<AuditPage> => (await call("GET", `/audit${query}`, as)).json();
/** The account's latest event. */
const latest = async (as: TestUser = admin): Promise<AuditEvent> => (await log(as)).events[0];

describe("the audit log", () => {
  it("says who changed what, and still names what a request deleted", async () => {
    const tenant = (await call("POST", "/tenants", admin, { name: "Audited", host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
    expect(await latest()).toMatchObject({
      userEmail: admin.email,
      action: "POST /tenants",
      label: "Added a tenant",
      group: "Tenants",
      target: null,
      detail: { name: "Audited", host: "https://synthetic.eu10.hcs.cloud.sap" },
      ip: "127.0.0.1",
    });

    const pipeline = await call("POST", `/tenants/${tenant.id}/pipelines`, developer, { name: "Orders", output: "S.V_OUT", excludeWriters: [] });
    expect(pipeline.statusCode).toBe(201);
    expect(await latest()).toMatchObject({ label: "Saved a pipeline", target: { kind: "tenant", id: tenant.id, name: "Audited" }, detail: { name: "Orders", output: "S.V_OUT" } });

    expect((await call("DELETE", `/pipelines/${pipeline.json().id}`, developer)).statusCode).toBe(204);
    expect(await latest()).toMatchObject({ label: "Deleted the pipeline", target: { kind: "pipeline", id: pipeline.json().id, name: "Orders", tenantId: tenant.id }, detail: null });

    // A member's role, with the email as it was, and the user still named once they are removed.
    const leaving = await testUser(db, { account: "Customer", email: "leaving@customer.example.com", role: "viewer" });
    await call("PATCH", `/team/members/${leaving.userId}`, admin, { role: "viewer", spaces: ["SALES"] });
    expect(await latest()).toMatchObject({ label: "Changed the member's role or spaces", target: { name: leaving.email }, detail: { role: "viewer", spaces: ["SALES"] } });
    await call("DELETE", `/team/members/${leaving.userId}`, admin);
    expect(await latest()).toMatchObject({ label: "Removed the member", target: { kind: "member", name: leaving.email } });
  });

  it("never keeps a secret", async () => {
    const tenant = (await call("POST", "/tenants", admin, { name: "Secrets", host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
    expect((await call("PUT", `/tenants/${tenant.id}/connection`, admin, client)).statusCode).toBe(200);
    expect(await latest()).toMatchObject({ label: "Set the technical client", detail: { clientId: client.clientId, tokenUrl: client.tokenUrl, spaces: ["SALES"] } });
    const database = { host: "synthetic.hana.prod-eu10.hanacloud.ondemand.com", user: "SALES#SYNTH", password: "synthetic-database-password" };
    expect((await call("PUT", `/tenants/${tenant.id}/database-users`, admin, database)).statusCode).toBe(200);
    expect((await latest()).detail).toEqual({ user: "SALES#SYNTH", host: database.host });
    expect((await call("PUT", "/account/teams-channel", admin, { url: WEBHOOK })).statusCode).toBe(200);
    expect(await latest()).toMatchObject({ label: "Connected a Teams channel", detail: null });

    const { rows } = await db.query<{ row: string }>("select row_to_json(e)::text as row from audit_events e");
    for (const secret of [client.clientSecret, database.password, "sig=SECRET"]) expect(rows.filter((r) => r.row.includes(secret))).toEqual([]);
  });

  it("writes nothing for a request that was refused or failed", async () => {
    const before = (await log(admin)).events.length;
    const tenant = (await call("GET", "/tenants", admin)).json()[0];
    expect((await call("DELETE", `/tenants/${tenant.id}`, developer)).statusCode).toBe(403);
    expect((await call("DELETE", "/pipelines/00000000-0000-4000-8000-000000000000", developer)).statusCode).toBe(404);
    expect((await call("POST", "/tenants", admin, { name: "" })).statusCode).toBe(400);
    expect((await call("DELETE", `/tenants/${tenant.id}`, stranger)).statusCode).toBe(404);
    expect((await log(admin)).events.length).toBe(before);
  });

  it("logs a sign-in once the code is checked, and a switch to another account in that account", async () => {
    const user = await testUser(db, { account: "Customer", email: "signs.in@customer.example.com", role: "viewer" });
    const login = await call("POST", "/auth/login", undefined, { email: user.email, password: TEST_PASSWORD });
    expect((await latest()).userEmail).not.toBe(user.email);
    const code = await app.inject({ method: "POST", url: "/api/auth/code", headers: { cookie: cookieOf(login) }, payload: { code: totpCode(user.totpSecret, totpStep()) } });
    expect(code.statusCode).toBe(200);
    const cookie = cookieOf(code);
    expect(await latest()).toMatchObject({ userEmail: user.email, label: "Signed in", group: "Sign-in" });

    const second = await testUser(db, { account: "Second", email: user.email, role: "admin" });
    const switched = await app.inject({ method: "POST", url: "/api/auth/account", headers: { cookie }, payload: { accountId: second.accountId } });
    expect(switched.statusCode).toBe(200);
    expect((await latest(second)).label).toBe("Switched to this account");
    expect((await latest()).label).toBe("Signed in");
  });

  it("is for admins only, and each account sees its own", async () => {
    expect((await call("GET", "/audit", developer)).statusCode).toBe(403);
    expect((await call("GET", "/audit.csv", developer)).statusCode).toBe(403);
    expect((await call("GET", "/audit/users", developer)).statusCode).toBe(403);
    await call("POST", "/tenants", stranger, { name: "Theirs", host: "https://synthetic.eu10.hcs.cloud.sap" });
    expect((await log(stranger)).events.map((e) => e.userEmail)).toEqual([stranger.email]);
    expect((await log(admin)).events.some((e) => e.userEmail === stranger.email)).toBe(false);
  });

  it("keeps the operator panel's events out of every account's log", async () => {
    const ops = await testUser(db, { account: "Customer", email: "ops@ystara.example.com", role: "admin", operator: true });
    expect((await call("POST", "/operator/accounts", ops, { name: "Operated", adminEmail: "first@operated.example.com" })).statusCode).toBe(201);
    expect((await latest(ops)).label).not.toBe("Created an account");
    const { rows } = await db.query("select account_id, user_email, detail from audit_events where action = 'POST /operator/accounts'");
    expect(rows).toEqual([{ account_id: null, user_email: ops.email, detail: { name: "Operated", adminEmail: "first@operated.example.com" } }]);
  });

  it("filters by user, group and dates, a page at a time, and exports the same as CSV", async () => {
    const account = await testUser(db, { account: "Busy", email: "admin@busy.example.com", role: "admin" });
    const other = await testUser(db, { account: "Busy", email: "other@busy.example.com", role: "developer" });
    for (let i = 0; i < 105; i++) {
      await recordAuditEvent(db, { accountId: account.accountId, userId: i % 2 ? other.userId : account.userId, action: i < 100 ? "POST /tenants" : "PUT /tenants/:id/scan-schedule", target: null, detail: { n: i }, ip: "10.0.0.1" });
    }
    const first = await log(account);
    expect(first.events).toHaveLength(100);
    expect(first.events[0].detail).toEqual({ n: 104 });
    const second = await log(account, `?before=${first.next}`);
    expect(second.events.map((e) => e.detail!.n)).toEqual([4, 3, 2, 1, 0]);
    expect(second.next).toBeNull();

    expect((await log(account, "?group=Discovery")).events.map((e) => e.label)).toEqual(Array(5).fill("Set the scan schedule"));
    expect((await log(account, `?user=${encodeURIComponent(other.email.toUpperCase())}`)).events.every((e) => e.userEmail === other.email)).toBe(true);
    expect((await call("GET", "/audit/users", account)).json()).toEqual([account.email, other.email]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await log(account, `?from=${tomorrow}`)).events).toEqual([]);
    expect((await log(account, `?to=${tomorrow}`)).events).toHaveLength(100);
    expect((await call("GET", "/audit?group=Nothing", account)).statusCode).toBe(400);

    const csv = await call("GET", "/audit.csv?group=Discovery", account);
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toMatch(/^attachment; filename="ystara-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = csv.body.split("\r\n");
    expect(lines[0]).toBe("﻿When (UTC),Who,What,Group,Target,Target ID,Details,IP address");
    expect(lines).toHaveLength(7);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,admin@busy\.example\.com,Set the scan schedule,Discovery,,,"\{""n"":104\}",10\.0\.0\.1$/);
  });
});

describe("every route", () => {
  it("that changes something says how it reads in the log, or the API doesn't start", async () => {
    const bare = Fastify();
    installAudit(bare, db);
    expect(() => bare.post("/api/unlisted", async () => "")).toThrow("POST /unlisted is not in AUDIT_ACTIONS");
    expect(() => bare.get("/api/unlisted", async () => "")).not.toThrow();
    await bare.close();
  });

  it("listed in the log exists", () => {
    for (const key of Object.keys(AUDIT_ACTIONS)) {
      const [method, url] = key.split(" ");
      expect([key, app.hasRoute({ method: method as "POST", url: `/api${url}` })]).toEqual([key, true]);
    }
  });
});

/** The session cookie a response sets, as a Cookie header. */
function cookieOf(res: LightMyRequestResponse) {
  const set = res.cookies.find((c) => c.name === "ystara_session")!;
  return `ystara_session=${set.value}`;
}
