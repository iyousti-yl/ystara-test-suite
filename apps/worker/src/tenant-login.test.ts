import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasphereCli } from "@ystara/connector";
import { createAccount, createTenant, setConnection, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { connectionSecretContext, secretBox } from "@ystara/shared/secrets";
import { listSpacesWith, removeStaleFolders, tenantAccess } from "./tenant-login.js";

const host = "https://synthetic.eu10.hcs.cloud.sap";
const tokenUrl = "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token";

// A stand-in for the Datasphere CLI that prints how it was started. A shell script, so not on Windows.
describe.skipIf(process.platform === "win32")("how a scan logs in to a tenant", () => {
  const secrets = secretBox(randomBytes(32));
  let db: Db;
  let accountId: string;
  let dir: string;
  let bin: string;
  const called = () => existsSync(path.join(dir, "called"));

  beforeAll(async () => {
    db = await createTestDb();
    accountId = (await createAccount(db, "Synthetic customer")).id;
    dir = await mkdtemp(path.join(tmpdir(), "ystara-worker-"));
    bin = path.join(dir, "fake-datasphere");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(dir, "called"))}, "yes");
const args = process.argv.slice(2);
const i = args.indexOf("--secrets-file");
console.log(JSON.stringify({ args, home: process.env.HOME, secrets: i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], "utf8")) : null }));
`,
    );
    await chmod(bin, 0o755);
  });
  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (cli: DatasphereCli) => JSON.parse(await cli.exec({ group: "spaces", verb: "list" }));
  async function connected(name: string, more: { host?: string; tokenUrl?: string } = {}) {
    const tenant = await createTenant(db, { accountId, name, host: more.host ?? host });
    const sealedSecret = secrets.seal("synthetic-secret", connectionSecretContext(tenant.id));
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-synthetic", sealedSecret, tokenUrl: more.tokenUrl ?? tokenUrl, updatedBy: null });
    return tenant;
  }

  it("uses the tenant's technical client, in a folder of its own that is deleted afterwards", async () => {
    const access = await tenantAccess(db, secrets, await connected("Connected"), { bin });
    expect(access).toMatchObject({ login: "client", client: { clientId: "sb-synthetic", clientSecret: "synthetic-secret" } });
    const { home, secrets: file } = await run(access.source as DatasphereCli);
    expect(file).toMatchObject({ client_id: "sb-synthetic", client_secret: "synthetic-secret", token_url: tokenUrl });
    expect(home).not.toBe(process.env.HOME);
    expect(existsSync(home)).toBe(true);

    await access.close!();
    expect(existsSync(home)).toBe(false);
  });

  it("does not scan a tenant without a client, unless the worker was started for this machine's own login", async () => {
    const tenant = await createTenant(db, { accountId, name: "Not connected", host });
    await rm(path.join(dir, "called"), { force: true });
    await expect(tenantAccess(db, secrets, tenant, { bin })).rejects.toThrow("This tenant is not connected: an admin connects it on the tenant page.");
    expect(called()).toBe(false);

    const access = await tenantAccess(db, secrets, tenant, { bin, machineLogin: true });
    expect(access.login).toBe("machine");
    expect(await run(access.source as DatasphereCli)).toMatchObject({ home: process.env.HOME, secrets: null });
  });

  it("logs in nowhere but Datasphere and SAP's sign-in service, for rows saved before that rule", async () => {
    await rm(path.join(dir, "called"), { force: true });
    const elsewhere = await connected("Elsewhere", { host: "https://10.0.0.1" });
    await expect(tenantAccess(db, secrets, elsewhere, { bin })).rejects.toThrow(/only connects to SAP Datasphere tenants/);
    const unconnected = await createTenant(db, { accountId, name: "Elsewhere, no client", host: "https://synthetic.example.com" });
    await expect(tenantAccess(db, secrets, unconnected, { bin, machineLogin: true })).rejects.toThrow(/only connects to SAP Datasphere tenants/);

    const app = await connected("App on SAP's cloud", { tokenUrl: "https://synthetic.cfapps.eu10.hana.ondemand.com/oauth/token" });
    await expect(tenantAccess(db, secrets, app, { bin })).rejects.toThrow(/token URL is not on SAP's sign-in service/);
    await expect(listSpacesWith(host, { clientId: "sb-synthetic", clientSecret: "x", tokenUrl: "https://synthetic.example.com/oauth/token" }, bin)).rejects.toThrow(
      /token URL/,
    );
    expect(called()).toBe(false);
  });

  it("can't open a secret copied from another tenant's row", async () => {
    const source = await connected("Source");
    const copy = await createTenant(db, { accountId, name: "Copy", host });
    const sealedSecret = secrets.seal("synthetic-secret", connectionSecretContext(source.id));
    await setConnection(db, { tenantId: copy.id, clientId: "sb-synthetic", sealedSecret, tokenUrl, updatedBy: null });
    await expect(tenantAccess(db, secrets, copy, { bin })).rejects.toThrow(/can't be opened for this tenant/);
  });
});

describe("temporary CLI folders left behind", () => {
  it("are deleted when older than any job, and nothing else is", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ystara-stale-"));
    try {
      const old = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
      for (const name of ["ystara-tenant-old", "ystara-tenant-running", "ystara-scan-old"]) await mkdir(path.join(dir, name));
      await writeFile(path.join(dir, "ystara-tenant-old", "ystara-client.json"), "{}");
      await utimes(path.join(dir, "ystara-tenant-old"), old, old);
      await utimes(path.join(dir, "ystara-scan-old"), old, old);

      expect(await removeStaleFolders(dir)).toBe(1);
      expect(existsSync(path.join(dir, "ystara-tenant-old"))).toBe(false);
      expect(existsSync(path.join(dir, "ystara-tenant-running"))).toBe(true);
      expect(existsSync(path.join(dir, "ystara-scan-old"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
