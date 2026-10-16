import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTenant, getConnectionLogin, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { JOBS } from "@ystara/shared";
import { testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { buildServer } from "../server.js";

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
let developer: TestUser;
let viewer: TestUser;
let stranger: TestUser;
const sent: { name: string; data: object }[] = [];

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async (name, data) => sent.push({ name, data }) }, secrets: testSecrets }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
  developer = await testUser(db, { account: "Customer", email: "dev@customer.example.com", role: "developer" });
  viewer = await testUser(db, { account: "Customer", email: "viewer@customer.example.com", role: "viewer" });
  stranger = await testUser(db, { account: "Elsewhere", email: "admin@elsewhere.example.com", role: "admin" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, as: TestUser, payload?: object) =>
  app.inject({ method, url: `/api${url}`, payload, headers: { cookie: as.cookie } });

const client = { clientId: "sb-synthetic-client", clientSecret: "synthetic-secret-value", tokenUrl: "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token" };

async function newTenant(name: string) {
  return (await call("POST", "/tenants", admin, { name, host: "https://synthetic.example.com" })).json() as { id: string };
}

describe("a tenant's technical client", () => {
  it("is saved by an admin, sealed, checked by the worker and never sent back", async () => {
    const tenant = await newTenant("Production");
    expect((await call("GET", `/tenants/${tenant.id}/connection`, viewer)).json()).toEqual({ connection: null });

    sent.length = 0;
    const res = await call("PUT", `/tenants/${tenant.id}/connection`, admin, client);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ clientId: client.clientId, tokenUrl: client.tokenUrl, status: "checking", spaces: [] });
    expect(sent).toEqual([{ name: JOBS.connectionCheck, data: { tenantId: tenant.id } }]);

    // Stored sealed, and opened only with MASTER_KEY.
    const login = (await getConnectionLogin(db, tenant.id))!;
    expect(login.sealedSecret).not.toContain(client.clientSecret);
    expect(testSecrets.open(login.sealedSecret)).toBe(client.clientSecret);

    for (const as of [admin, developer, viewer]) {
      const read = await call("GET", `/tenants/${tenant.id}/connection`, as);
      expect(read.json().connection).toMatchObject({ clientId: client.clientId, status: "checking" });
      expect(read.body).not.toContain(client.clientSecret);
      expect(read.body).not.toContain(login.sealedSecret);
    }
  });

  it("is entered, changed and removed by admins only; anyone who scans may check it again", async () => {
    const tenant = await newTenant("Quality");
    expect((await call("PUT", `/tenants/${tenant.id}/connection`, developer, client)).statusCode).toBe(403);
    expect((await call("PUT", `/tenants/${tenant.id}/connection`, admin, client)).statusCode).toBe(200);

    sent.length = 0;
    expect((await call("POST", `/tenants/${tenant.id}/connection/check`, viewer)).statusCode).toBe(403);
    expect((await call("POST", `/tenants/${tenant.id}/connection/check`, developer)).statusCode).toBe(202);
    expect(sent).toEqual([{ name: JOBS.connectionCheck, data: { tenantId: tenant.id } }]);

    expect((await call("DELETE", `/tenants/${tenant.id}/connection`, developer)).statusCode).toBe(403);
    expect((await call("DELETE", `/tenants/${tenant.id}/connection`, admin)).statusCode).toBe(204);
    expect((await call("GET", `/tenants/${tenant.id}/connection`, admin)).json()).toEqual({ connection: null });
    expect((await call("POST", `/tenants/${tenant.id}/connection/check`, admin)).statusCode).toBe(404);
  });

  it("is another account's business: 404, as if the tenant didn't exist", async () => {
    const tenant = await newTenant("Private");
    await call("PUT", `/tenants/${tenant.id}/connection`, admin, client);
    for (const [method, payload] of [["GET"], ["PUT", client], ["POST"], ["DELETE"]] as const) {
      const url = method === "POST" ? `/tenants/${tenant.id}/connection/check` : `/tenants/${tenant.id}/connection`;
      expect((await call(method, url, stranger, payload)).statusCode).toBe(404);
    }
    expect((await getConnectionLogin(db, tenant.id))?.clientId).toBe(client.clientId);
  });

  it("needs SAP's token URL, and a tenant with a Datasphere URL", async () => {
    const tenant = await newTenant("Checked input");
    for (const tokenUrl of [
      "http://synthetic.authentication.eu10.hana.ondemand.com/oauth/token",
      "https://synthetic.example.com/oauth/token",
      "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/authorize",
      "https://synthetic.authentication.eu10.hana.ondemand.com.example.com/oauth/token",
      "not a url",
    ]) {
      expect((await call("PUT", `/tenants/${tenant.id}/connection`, admin, { ...client, tokenUrl })).statusCode, tokenUrl).toBe(400);
    }
    expect((await call("PUT", `/tenants/${tenant.id}/connection`, admin, { ...client, clientSecret: " " })).statusCode).toBe(400);

    // As `npm run db:import` makes them.
    const imported = await createTenant(db, { accountId: admin.accountId, name: "Imported only", host: null });
    expect((await call("PUT", `/tenants/${imported.id}/connection`, admin, client)).statusCode).toBe(409);
  });
});
