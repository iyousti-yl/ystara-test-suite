import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTenant, getDatabaseUserLogin, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { JOBS } from "@ystara/shared";
import { databaseUserSecretContext } from "@ystara/shared/secrets";
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

const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";
const salesUser = { host, user: "SALES#SYNTH", password: "synthetic-password-value" };

async function newTenant(name: string) {
  return (await call("POST", "/tenants", admin, { name, host: "https://synthetic.eu10.hcs.cloud.sap" })).json() as { id: string };
}

describe("a space's database user", () => {
  it("is saved by an admin for the space its name starts with, sealed, checked by the worker and never sent back", async () => {
    const tenant = await newTenant("Production");
    expect((await call("GET", `/tenants/${tenant.id}/database-users`, viewer)).json()).toEqual([]);

    sent.length = 0;
    const res = await call("PUT", `/tenants/${tenant.id}/database-users`, admin, { ...salesUser, host: host.toUpperCase() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ space: "SALES", host, user: "SALES#SYNTH", status: "checking", visible: null });
    expect(sent).toEqual([{ name: JOBS.databaseCheck, data: { tenantId: tenant.id, space: "SALES" } }]);

    // Stored sealed, and opened only with MASTER_KEY, for this tenant and space.
    const login = (await getDatabaseUserLogin(db, tenant.id, "SALES"))!;
    expect(login.sealedPassword).not.toContain(salesUser.password);
    expect(testSecrets.open(login.sealedPassword, databaseUserSecretContext(tenant.id, "SALES"))).toBe(salesUser.password);
    expect(() => testSecrets.open(login.sealedPassword, databaseUserSecretContext(tenant.id, "FINANCE"))).toThrow();

    for (const as of [admin, developer, viewer]) {
      const read = await call("GET", `/tenants/${tenant.id}/database-users`, as);
      expect(read.json()).toMatchObject([{ space: "SALES", user: "SALES#SYNTH", status: "checking" }]);
      expect(read.body).not.toContain(salesUser.password);
      expect(read.body).not.toContain(login.sealedPassword);
    }
  });

  it("is entered, changed and removed by admins only; anyone who scans may check it again", async () => {
    const tenant = await newTenant("Quality");
    const users = `/tenants/${tenant.id}/database-users`;
    expect((await call("PUT", users, developer, salesUser)).statusCode).toBe(403);
    expect((await call("PUT", users, admin, salesUser)).statusCode).toBe(200);

    sent.length = 0;
    expect((await call("POST", `${users}/SALES/check`, viewer)).statusCode).toBe(403);
    expect((await call("POST", `${users}/SALES/check`, developer)).statusCode).toBe(202);
    expect(sent).toEqual([{ name: JOBS.databaseCheck, data: { tenantId: tenant.id, space: "SALES" } }]);
    expect((await call("POST", `${users}/FINANCE/check`, admin)).statusCode).toBe(404);

    expect((await call("DELETE", `${users}/SALES`, developer)).statusCode).toBe(403);
    expect((await call("DELETE", `${users}/SALES`, admin)).statusCode).toBe(204);
    expect((await call("GET", users, admin)).json()).toEqual([]);
    expect((await call("DELETE", `${users}/SALES`, admin)).statusCode).toBe(404);
  });

  it("is another account's business: 404, as if the tenant didn't exist", async () => {
    const tenant = await newTenant("Private");
    const users = `/tenants/${tenant.id}/database-users`;
    await call("PUT", users, admin, salesUser);
    expect((await call("GET", users, stranger)).statusCode).toBe(404);
    expect((await call("PUT", users, stranger, { ...salesUser, password: "theirs" })).statusCode).toBe(404);
    expect((await call("POST", `${users}/SALES/check`, stranger)).statusCode).toBe(404);
    expect((await call("DELETE", `${users}/SALES`, stranger)).statusCode).toBe(404);
    const login = (await getDatabaseUserLogin(db, tenant.id, "SALES"))!;
    expect(testSecrets.open(login.sealedPassword, databaseUserSecretContext(tenant.id, "SALES"))).toBe(salesUser.password);
  });

  it("accepts the hna1, hna2… hosts of newer tenants", async () => {
    const tenant = await newTenant("Newer tenant");
    const newer = "synthetic.hna1.prod-eu10.hanacloud.ondemand.com";
    const res = await call("PUT", `/tenants/${tenant.id}/database-users`, admin, { ...salesUser, host: newer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ host: newer, status: "checking" });
  });

  it("needs a Datasphere database host and a SPACE#SUFFIX name, and a tenant with a Datasphere URL", async () => {
    const tenant = await newTenant("Checked input");
    const users = `/tenants/${tenant.id}/database-users`;
    for (const wrong of [
      "https://synthetic.hana.prod-eu10.hanacloud.ondemand.com",
      "synthetic.hana.prod-eu10.hanacloud.ondemand.com:443",
      "synthetic.hana.prod-eu10.hanacloud.ondemand.com.example.com",
      "synthetic.example.com",
      "10.0.0.1",
    ]) {
      expect((await call("PUT", users, admin, { ...salesUser, host: wrong })).statusCode, wrong).toBe(400);
    }
    for (const user of ["SALES", "SALES#", "SALES#A#B", "SAL-ES#SYNTH", "SALES #SYNTH"]) {
      const res = await call("PUT", users, admin, { ...salesUser, user });
      expect(res.statusCode, user).toBe(400);
    }
    expect((await call("PUT", users, admin, { ...salesUser, password: " " })).statusCode).toBe(400);
    expect((await call("POST", `/tenants/${tenant.id}/database-users/bad space/check`, admin)).statusCode).toBe(400);
    expect(sent.filter((s) => (s.data as { tenantId: string }).tenantId === tenant.id)).toEqual([]);

    // As `npm run db:import` makes them.
    const imported = await createTenant(db, { accountId: admin.accountId, name: "Imported only", host: null });
    expect((await call("PUT", `/tenants/${imported.id}/database-users`, admin, salesUser)).statusCode).toBe(409);
  });
});
