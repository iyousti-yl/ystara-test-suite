import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatasphereCli } from "@ystara/connector";
import { createAccount, createTenant, setConnection, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { secretBox } from "@ystara/shared/secrets";
import { tenantAccess } from "./tenant-login.js";

// A stand-in for the Datasphere CLI that prints how it was started. A shell script, so not on Windows.
describe.skipIf(process.platform === "win32")("how a scan logs in to a tenant", () => {
  const secrets = secretBox(randomBytes(32));
  let db: Db;
  let accountId: string;
  let dir: string;
  let bin: string;

  beforeAll(async () => {
    db = await createTestDb();
    accountId = (await createAccount(db, "Synthetic customer")).id;
    dir = await mkdtemp(path.join(tmpdir(), "ystara-worker-"));
    bin = path.join(dir, "fake-datasphere");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
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

  it("uses the tenant's technical client, in a folder of its own that is deleted afterwards", async () => {
    const tenant = await createTenant(db, { accountId, name: "Connected", host: "https://synthetic.example.com" });
    const tokenUrl = "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token";
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-synthetic", sealedSecret: secrets.seal("synthetic-secret"), tokenUrl, updatedBy: null });

    const access = await tenantAccess(db, secrets, tenant, bin);
    expect(access).toMatchObject({ login: "client", hide: ["synthetic-secret"] });
    const { home, secrets: file } = await run(access.source as DatasphereCli);
    expect(file).toMatchObject({ client_id: "sb-synthetic", client_secret: "synthetic-secret", token_url: tokenUrl });
    expect(home).not.toBe(process.env.HOME);
    expect(existsSync(home)).toBe(true);

    await access.close!();
    expect(existsSync(home)).toBe(false);
  });

  it("uses this machine's own CLI login for a tenant without a client", async () => {
    const tenant = await createTenant(db, { accountId, name: "Not connected", host: "https://synthetic.example.com" });
    const access = await tenantAccess(db, secrets, tenant, bin);
    expect(access.login).toBe("machine");
    expect(await run(access.source as DatasphereCli)).toMatchObject({ home: process.env.HOME, secrets: null });
  });
});
