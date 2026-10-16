import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TechnicalClient } from "@ystara/connector";
import { createAccount, createTenant, getConnection, getConnectionLogin, setConnection, setConnectionSpaces, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { connectionSecretContext, secretBox } from "@ystara/shared/secrets";
import { runConnectionCheck } from "./connection-check.js";

const secrets = secretBox(randomBytes(32));
const tokenUrl = "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token";
const host = "https://synthetic.eu10.hcs.cloud.sap";

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterAll(async () => {
  await db.close();
});

async function connectedTenant(name: string, spaces = ["SALES", "FINANCE"]) {
  const tenant = await createTenant(db, { accountId, name, host });
  const sealedSecret = secrets.seal("synthetic-secret", connectionSecretContext(tenant.id));
  await setConnection(db, { tenantId: tenant.id, clientId: "sb-synthetic", sealedSecret, tokenUrl, spaces, updatedBy: null });
  return tenant;
}
const readable = (space: string) => ({ space, readable: true, error: null });

describe("the connection check", () => {
  it("logs in with the client, secret opened, and stores each space's result", async () => {
    const tenant = await connectedTenant("Production");
    let used: TechnicalClient | undefined;
    const done = await runConnectionCheck(db, tenant.id, secrets, async (checkedHost, client, spaces) => {
      expect(checkedHost).toBe(host);
      expect(spaces).toEqual(["SALES", "FINANCE"]);
      used = client;
      return [readable("SALES"), { space: "FINANCE", readable: false, error: "403 Forbidden" }];
    });
    expect(used).toEqual({ clientId: "sb-synthetic", clientSecret: "synthetic-secret", tokenUrl });
    expect(done).toMatchObject({ status: "connected", error: null, spaces: [readable("SALES"), { space: "FINANCE", readable: false, error: "403 Forbidden" }] });
  });

  it("is not connected when no space can be read", async () => {
    const tenant = await connectedTenant("No rights", ["SALES"]);
    const done = await runConnectionCheck(db, tenant.id, secrets, async () => [{ space: "SALES", readable: false, error: "403 Forbidden" }]);
    expect(done).toMatchObject({ status: "failed", spaces: [{ space: "SALES", readable: false, error: "403 Forbidden" }] });
  });

  it("stores why the login failed, without the secret or a token", async () => {
    const tenant = await connectedTenant("Wrong secret");
    const done = await runConnectionCheck(db, tenant.id, secrets, async (_host, client) => {
      const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
      const stderr = [`POST ${tokenUrl} with ${client.clientSecret}`, `Authorization: Basic ${basic}`, '{"access_token":"opaque-synthetic"}', "401 Unauthorized"];
      throw Object.assign(new Error("Command failed"), { stderr: stderr.join("\n") });
    });
    expect(done).toMatchObject({ status: "failed", spaces: [{ space: "SALES", readable: null }, { space: "FINANCE", readable: null }] });
    expect(done?.error).toBe(`POST ${tokenUrl} with <secret>\nAuthorization: Basic <secret>\n{"access_token":"<secret>"}\n401 Unauthorized`);
  });

  it("says what to do when this MASTER_KEY can't open the secret", async () => {
    const tenant = await connectedTenant("Other key");
    const otherKey = secretBox(randomBytes(32));
    const done = await runConnectionCheck(db, tenant.id, otherKey, async () => [readable("SALES")]);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/MASTER_KEY.*enters the client again/);
  });

  it("drops its verdict when the client or its spaces changed while it ran", async () => {
    const tenant = await connectedTenant("Changed meanwhile");
    const done = await runConnectionCheck(db, tenant.id, secrets, async () => {
      const sealedSecret = secrets.seal("newer", connectionSecretContext(tenant.id));
      await setConnection(db, { tenantId: tenant.id, clientId: "sb-newer", sealedSecret, tokenUrl, spaces: ["SALES"], updatedBy: null });
      return [readable("SALES")];
    });
    expect(done).toMatchObject({ clientId: "sb-newer", status: "checking", spaces: [{ space: "SALES", readable: null }] });
    expect((await getConnectionLogin(db, tenant.id))?.clientId).toBe("sb-newer");

    const again = await runConnectionCheck(db, tenant.id, secrets, async () => {
      await setConnectionSpaces(db, tenant.id, ["SALES", "HR"], null);
      return [readable("SALES")];
    });
    expect(again).toMatchObject({ status: "checking", spaces: [{ space: "SALES", readable: null }, { space: "HR", readable: null }] });
  });

  it("does nothing for a client removed while queued", async () => {
    const tenant = await createTenant(db, { accountId, name: "Never connected", host });
    expect(await runConnectionCheck(db, tenant.id, secrets, async () => [readable("SALES")])).toBeUndefined();
    expect(await getConnection(db, tenant.id)).toBeUndefined();
  });
});
