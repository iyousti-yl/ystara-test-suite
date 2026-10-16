import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TechnicalClient } from "@ystara/connector";
import { createAccount, createTenant, getConnection, getConnectionLogin, setConnection, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { secretBox } from "@ystara/shared/secrets";
import { runConnectionCheck } from "./connection-check.js";

const secrets = secretBox(randomBytes(32));
const tokenUrl = "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token";

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterAll(async () => {
  await db.close();
});

async function connectedTenant(name: string, secret = "synthetic-secret") {
  const tenant = await createTenant(db, { accountId, name, host: "https://synthetic.example.com" });
  await setConnection(db, { tenantId: tenant.id, clientId: "sb-synthetic", sealedSecret: secrets.seal(secret), tokenUrl, updatedBy: null });
  return tenant;
}

describe("the connection check", () => {
  it("logs in with the client, secret opened, and stores the spaces it sees", async () => {
    const tenant = await connectedTenant("Production");
    let used: TechnicalClient | undefined;
    const done = await runConnectionCheck(db, tenant.id, secrets, async (host, client) => {
      expect(host).toBe("https://synthetic.example.com");
      used = client;
      return ["SALES", "FINANCE", "SALES"];
    });
    expect(used).toEqual({ clientId: "sb-synthetic", clientSecret: "synthetic-secret", tokenUrl });
    expect(done).toMatchObject({ status: "connected", spaces: ["FINANCE", "SALES"], error: null });
  });

  it("stores why the login failed, without the secret", async () => {
    const tenant = await connectedTenant("Wrong secret");
    const done = await runConnectionCheck(db, tenant.id, secrets, async (_host, client) => {
      throw Object.assign(new Error("Command failed"), { stderr: `POST ${tokenUrl} with ${client.clientSecret}\n401 Unauthorized` });
    });
    expect(done).toMatchObject({ status: "failed", spaces: [] });
    expect(done?.error).toBe(`POST ${tokenUrl} with <secret>\n401 Unauthorized`);
  });

  it("says what to do when this MASTER_KEY can't open the secret", async () => {
    const tenant = await connectedTenant("Other key");
    const otherKey = secretBox(randomBytes(32));
    const done = await runConnectionCheck(db, tenant.id, otherKey, async () => ["SALES"]);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/MASTER_KEY.*enters the client again/);
  });

  it("drops its verdict when the client changed while it ran", async () => {
    const tenant = await connectedTenant("Changed meanwhile");
    const done = await runConnectionCheck(db, tenant.id, secrets, async () => {
      await setConnection(db, { tenantId: tenant.id, clientId: "sb-newer", sealedSecret: secrets.seal("newer"), tokenUrl, updatedBy: null });
      return ["SALES"];
    });
    expect(done).toMatchObject({ clientId: "sb-newer", status: "checking", spaces: [] });
    expect((await getConnectionLogin(db, tenant.id))?.clientId).toBe("sb-newer");
  });

  it("does nothing for a client removed while queued", async () => {
    const tenant = await createTenant(db, { accountId, name: "Never connected", host: "https://synthetic.example.com" });
    expect(await runConnectionCheck(db, tenant.id, secrets, async () => ["SALES"])).toBeUndefined();
    expect(await getConnection(db, tenant.id)).toBeUndefined();
  });
});
