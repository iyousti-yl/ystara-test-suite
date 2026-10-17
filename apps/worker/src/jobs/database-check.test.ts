import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseUser } from "@ystara/connector";
import { createAccount, createTenant, getDatabaseUser, setDatabaseUser, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { databaseUserSecretContext, secretBox } from "@ystara/shared/secrets";
import { runDatabaseCheck } from "./database-check.js";

const secrets = secretBox(randomBytes(32));
const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";
const visible = [{ name: "ORDERS_SYNTH_V", type: "VIEW" as const }];

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterAll(async () => {
  await db.close();
});

async function tenantWithUser(name: string, more: { host?: string; password?: string } = {}) {
  const tenant = await createTenant(db, { accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const sealedPassword = secrets.seal(more.password ?? "synthetic-password", databaseUserSecretContext(tenant.id, "SALES"));
  await setDatabaseUser(db, { tenantId: tenant.id, space: "SALES", host: more.host ?? host, user: "SALES#SYNTH", sealedPassword, updatedBy: null });
  return tenant;
}

describe("the database check", () => {
  it("signs in with the user, password opened, and stores what it sees in its space", async () => {
    const tenant = await tenantWithUser("Production");
    let used: [DatabaseUser, string] | undefined;
    const done = await runDatabaseCheck(db, { tenantId: tenant.id, space: "SALES" }, secrets, async (user, space) => {
      used = [user, space];
      return { visible };
    });
    expect(used).toEqual([{ host, user: "SALES#SYNTH", password: "synthetic-password" }, "SALES"]);
    expect(done).toMatchObject({ status: "connected", error: null, visible });
  });

  it("stores why it failed", async () => {
    const tenant = await tenantWithUser("Could write");
    const done = await runDatabaseCheck(db, { tenantId: tenant.id, space: "SALES" }, secrets, async () => {
      throw new Error("This user can change the space's schema (INSERT).");
    });
    expect(done).toMatchObject({ status: "failed", error: "This user can change the space's schema (INSERT).", visible: null });
  });

  it("sends the password nowhere but a Datasphere database host", async () => {
    const tenant = await tenantWithUser("Saved before the rule", { host: "synthetic.example.com" });
    let called = false;
    const done = await runDatabaseCheck(db, { tenantId: tenant.id, space: "SALES" }, secrets, async () => {
      called = true;
      return { visible };
    });
    expect(called).toBe(false);
    expect(done?.error).toMatch(/not a Datasphere database host/);
  });

  it("says what to do when this MASTER_KEY can't open the password", async () => {
    const tenant = await tenantWithUser("Other key");
    const done = await runDatabaseCheck(db, { tenantId: tenant.id, space: "SALES" }, secretBox(randomBytes(32)), async () => ({ visible }));
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/MASTER_KEY.*enters the database user again/);
  });

  it("drops its verdict when the user was changed while it ran, and does nothing for one that was removed", async () => {
    const tenant = await tenantWithUser("Changed");
    const done = await runDatabaseCheck(db, { tenantId: tenant.id, space: "SALES" }, secrets, async () => {
      await setDatabaseUser(db, { tenantId: tenant.id, space: "SALES", host, user: "SALES#OTHER", sealedPassword: "v1.new", updatedBy: null });
      return { visible };
    });
    expect(done).toMatchObject({ user: "SALES#OTHER", status: "checking", visible: null });
    expect(await runDatabaseCheck(db, { tenantId: tenant.id, space: "FINANCE" }, secrets, async () => ({ visible }))).toBeUndefined();
    expect(await getDatabaseUser(db, tenant.id, "FINANCE")).toBeUndefined();
  });
});
