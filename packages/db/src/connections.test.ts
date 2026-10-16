import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount } from "./accounts.js";
import {
  deleteConnection,
  getConnection,
  getConnectionLogin,
  markConnectionChecking,
  recordConnectionCheck,
  setConnection,
  setConnectionSpaces,
} from "./connections.js";
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
const client = (tenantId: string, more: { clientId?: string; sealedSecret?: string; spaces?: string[] } = {}) => ({
  tenantId,
  clientId: more.clientId ?? "sb-client",
  sealedSecret: more.sealedSecret ?? "v1.sealed",
  tokenUrl,
  spaces: more.spaces ?? ["SALES", "FINANCE"],
  updatedBy: null,
});
const readable = (space: string) => ({ space, readable: true, error: null });
const unreadable = (space: string, error = "403 Forbidden") => ({ space, readable: false, error });
const unchecked = (space: string) => ({ space, readable: null, error: null });

describe("tenant connections", () => {
  it("starts checking every space, records each one's result, and keeps the secret out of what it returns", async () => {
    const tenant = await newTenant("Production");
    const saved = await setConnection(db, client(tenant.id));
    expect(saved).toMatchObject({ status: "checking", spaces: [unchecked("SALES"), unchecked("FINANCE")], error: null, checkedAt: null });
    expect(JSON.stringify(saved)).not.toContain("v1.sealed");

    const login = (await getConnectionLogin(db, tenant.id))!;
    expect(login).toMatchObject({ clientId: "sb-client", sealedSecret: "v1.sealed", tokenUrl, status: "checking", spaces: ["SALES", "FINANCE"] });
    expect(await recordConnectionCheck(db, login, { spaces: [readable("SALES"), unreadable("FINANCE")] })).toBe(true);
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "connected", spaces: [readable("SALES"), unreadable("FINANCE")], error: null });

    // Check again: the same client, so the results stay until the new verdict.
    await markConnectionChecking(db, tenant.id);
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "checking", spaces: [readable("SALES"), unreadable("FINANCE")] });
    expect(await recordConnectionCheck(db, login, { error: "401 Unauthorized" })).toBe(true);
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "failed", error: "401 Unauthorized", spaces: [unchecked("SALES"), unchecked("FINANCE")] });
  });

  it("is not connected when no space can be read", async () => {
    const tenant = await newTenant("No rights");
    await setConnection(db, client(tenant.id));
    await recordConnectionCheck(db, (await getConnectionLogin(db, tenant.id))!, { spaces: [unreadable("SALES"), unreadable("FINANCE")] });
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "failed", error: null, spaces: [unreadable("SALES"), unreadable("FINANCE")] });
  });

  it("changes the spaces without the secret, and drops a check of the old list", async () => {
    const tenant = await newTenant("More spaces");
    await setConnection(db, client(tenant.id, { spaces: ["SALES"] }));
    const old = (await getConnectionLogin(db, tenant.id))!;
    const changed = await setConnectionSpaces(db, tenant.id, ["SALES", "HR"], null);
    expect(changed).toMatchObject({ status: "checking", spaces: [unchecked("SALES"), unchecked("HR")] });
    expect((await getConnectionLogin(db, tenant.id))?.sealedSecret).toBe("v1.sealed");

    expect(await recordConnectionCheck(db, old, { spaces: [readable("SALES")] })).toBe(false);
    expect((await getConnection(db, tenant.id))?.status).toBe("checking");
    expect(await setConnectionSpaces(db, (await newTenant("Never connected")).id, ["SALES"], null)).toBeUndefined();
  });

  it("ignores a check of a client that was changed in the meantime", async () => {
    const tenant = await newTenant("Quality");
    await setConnection(db, client(tenant.id, { clientId: "sb-old", sealedSecret: "v1.old" }));
    const old = (await getConnectionLogin(db, tenant.id))!;
    await setConnection(db, client(tenant.id, { clientId: "sb-new", sealedSecret: "v1.new" }));

    expect(await recordConnectionCheck(db, old, { spaces: [readable("SALES")] })).toBe(false);
    expect(await getConnection(db, tenant.id)).toMatchObject({ clientId: "sb-new", status: "checking", spaces: [unchecked("SALES"), unchecked("FINANCE")] });
  });

  it("changing the client starts over, and removing it leaves nothing behind", async () => {
    const tenant = await newTenant("Development");
    await setConnection(db, client(tenant.id, { sealedSecret: "v1.one" }));
    await recordConnectionCheck(db, (await getConnectionLogin(db, tenant.id))!, { error: "wrong secret" });
    await setConnection(db, client(tenant.id, { sealedSecret: "v1.two" }));
    expect(await getConnection(db, tenant.id)).toMatchObject({ status: "checking", error: null, checkedAt: null });

    expect(await deleteConnection(db, tenant.id)).toBe(true);
    expect(await getConnection(db, tenant.id)).toBeUndefined();
    expect(await markConnectionChecking(db, tenant.id)).toBeUndefined();
    expect(await deleteConnection(db, tenant.id)).toBe(false);
  });
});
