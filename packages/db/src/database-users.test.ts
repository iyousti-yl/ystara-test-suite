import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount } from "./accounts.js";
import {
  deleteDatabaseUser,
  getDatabaseUser,
  getDatabaseUserLogin,
  listDatabaseUsers,
  markDatabaseUserChecking,
  recordDatabaseCheck,
  setDatabaseUser,
} from "./database-users.js";
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

const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";
async function newTenant(name: string) {
  const account = await createAccount(db, `Account of ${name}`);
  return createTenant(db, { accountId: account.id, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
}
const salesUser = (tenantId: string, sealedPassword = "v1.sealed") => ({ tenantId, space: "SALES", host, user: "SALES#SYNTH", sealedPassword, updatedBy: null });
const visible = [{ name: "ORDERS_SYNTH_V", type: "VIEW" as const }];

describe("space database users", () => {
  it("start checking, record what the user sees, and keep the password out of what they return", async () => {
    const tenant = await newTenant("Production");
    const saved = await setDatabaseUser(db, salesUser(tenant.id));
    expect(saved).toMatchObject({ space: "SALES", host, user: "SALES#SYNTH", status: "checking", visible: null, error: null, checkedAt: null });
    expect(JSON.stringify(saved)).not.toContain("v1.sealed");

    const login = (await getDatabaseUserLogin(db, tenant.id, "SALES"))!;
    expect(login).toMatchObject({ space: "SALES", host, user: "SALES#SYNTH", sealedPassword: "v1.sealed" });
    expect(await recordDatabaseCheck(db, login, { visible })).toBe(true);
    expect(await getDatabaseUser(db, tenant.id, "SALES")).toMatchObject({ status: "connected", visible, error: null });

    // Check again: what it saw stays until the new verdict, and a failure forgets it.
    expect(await markDatabaseUserChecking(db, tenant.id, "SALES")).toMatchObject({ status: "checking", visible });
    expect(await recordDatabaseCheck(db, login, { error: "Signing in failed" })).toBe(true);
    expect(await getDatabaseUser(db, tenant.id, "SALES")).toMatchObject({ status: "failed", error: "Signing in failed", visible: null });
  });

  it("are one per space, listed by space", async () => {
    const tenant = await newTenant("Several spaces");
    await setDatabaseUser(db, { ...salesUser(tenant.id), space: "SALES" });
    await setDatabaseUser(db, { ...salesUser(tenant.id), space: "FINANCE", user: "FINANCE#SYNTH" });
    await setDatabaseUser(db, { ...salesUser(tenant.id), user: "SALES#OTHER" });
    expect((await listDatabaseUsers(db, tenant.id)).map((u) => [u.space, u.user])).toEqual([
      ["FINANCE", "FINANCE#SYNTH"],
      ["SALES", "SALES#OTHER"],
    ]);
    expect(await listDatabaseUsers(db, (await newTenant("None")).id)).toEqual([]);
  });

  it("ignore a check of a user or password changed in the meantime", async () => {
    const tenant = await newTenant("Quality");
    await setDatabaseUser(db, salesUser(tenant.id, "v1.old"));
    const old = (await getDatabaseUserLogin(db, tenant.id, "SALES"))!;
    await recordDatabaseCheck(db, old, { visible });
    await setDatabaseUser(db, salesUser(tenant.id, "v1.new"));

    expect(await recordDatabaseCheck(db, old, { visible })).toBe(false);
    expect(await getDatabaseUser(db, tenant.id, "SALES")).toMatchObject({ status: "checking", visible: null, checkedAt: null });
  });

  it("leave nothing behind when removed", async () => {
    const tenant = await newTenant("Development");
    await setDatabaseUser(db, salesUser(tenant.id));
    expect(await deleteDatabaseUser(db, tenant.id, "SALES")).toBe(true);
    expect(await getDatabaseUserLogin(db, tenant.id, "SALES")).toBeUndefined();
    expect(await markDatabaseUserChecking(db, tenant.id, "SALES")).toBeUndefined();
    expect(await deleteDatabaseUser(db, tenant.id, "SALES")).toBe(false);
  });
});
