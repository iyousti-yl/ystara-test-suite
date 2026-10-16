import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount } from "./accounts.js";
import { deleteConnection, getConnection, getConnectionLogin, markConnectionChecking, recordConnectionCheck, setConnection } from "./connections.js";
import type { Db } from "./db.js";
import { createTenant } from "./tenants.js";
import { createTestDb } from "./testing.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const tokenUrl = "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token";
async function newTenant(name: string) {
  const account = await createAccount(db, `Account of ${name}`);
  return createTenant(db, { accountId: account.id, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
}

describe("tenant connections", () => {
  it("starts checking, records the spaces the client sees, and keeps the secret out of what it returns", async () => {
    const tenant = await newTenant("Production");
    const saved = await setConnection(db, { tenantId: tenant.id, clientId: "sb-client", sealedSecret: "v1.sealed", tokenUrl, updatedBy: null });
    expect(saved).toMatchObject({ status: "checking", spaces: [], error: null, checkedAt: null });
    expect(JSON.stringify(saved)).not.toContain("v1.sealed");

    const login = (await getConnectionLogin(db, tenant.id))!;
    expect(login).toMatchObject({ clientId: "sb-client", sealedSecret: "v1.sealed", tokenUrl, status: "checking" });
    expect(await recordConnectionCheck(db, login, { ok: true, spaces: ["SALES", "FINANCE"] })).toBe(true);
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "connected", spaces: ["SALES", "FINANCE"], error: null });

    // Check again: the same client, so the spaces stay until the new verdict.
    await markConnectionChecking(db, tenant.id);
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "checking", spaces: ["SALES", "FINANCE"] });
    expect(await recordConnectionCheck(db, login, { ok: false, error: "401 Unauthorized" })).toBe(true);
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "failed", error: "401 Unauthorized", spaces: ["SALES", "FINANCE"] });
  });

  it("ignores a check of a client that was changed in the meantime", async () => {
    const tenant = await newTenant("Quality");
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-old", sealedSecret: "v1.old", tokenUrl, updatedBy: null });
    const old = (await getConnectionLogin(db, tenant.id))!;
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-new", sealedSecret: "v1.new", tokenUrl, updatedBy: null });

    expect(await recordConnectionCheck(db, old, { ok: true, spaces: ["SALES"] })).toBe(false);
    expect(await getConnection(db, tenant.id)).toMatchObject({ clientId: "sb-new", status: "checking", spaces: [] });
  });

  it("changing the client starts over, and removing it leaves nothing behind", async () => {
    const tenant = await newTenant("Development");
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-one", sealedSecret: "v1.one", tokenUrl, updatedBy: null });
    await recordConnectionCheck(db, (await getConnectionLogin(db, tenant.id))!, { ok: false, error: "wrong secret" });
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-one", sealedSecret: "v1.two", tokenUrl, updatedBy: null });
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "checking", error: null, checkedAt: null });

    expect(await deleteConnection(db, tenant.id)).toBe(true);
    expect(await getConnection(db, tenant.id)).toBeUndefined();
    expect(await markConnectionChecking(db, tenant.id)).toBeUndefined();
    expect(await deleteConnection(db, tenant.id)).toBe(false);
  });
});
