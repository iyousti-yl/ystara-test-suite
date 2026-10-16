import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatasphereCli } from "./cli.js";
import { WriteAttemptError } from "./readonly.js";

// A stand-in for the Datasphere CLI that prints what it was started with. A shell script, so not on Windows.
describe.skipIf(process.platform === "win32")("Datasphere CLI wrapper", () => {
  let dir: string;
  let bin: string;
  const host = "https://synthetic.example.com";
  const client = { clientId: "client-id", clientSecret: "client-secret", tokenUrl: "https://synthetic.example.com/oauth/token" };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ystara-cli-"));
    bin = path.join(dir, "fake-datasphere");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(dir, "called"))}, "yes");
const args = process.argv.slice(2);
const i = args.indexOf("--secrets-file");
const file = i >= 0 ? args[i + 1] : null;
console.log(JSON.stringify({ args, home: process.env.HOME, secrets: file && JSON.parse(fs.readFileSync(file, "utf8")) }));
`,
    );
    await chmod(bin, 0o755);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("logs in with a technical client through a secrets file in the tenant's own folder", async () => {
    const configDir = await mkdtemp(path.join(dir, "tenant-"));
    const cli = new DatasphereCli({ host, bin, client, configDir });
    const run = JSON.parse(await cli.exec({ group: "objects", kind: "views", verb: "list" }, { space: "SALES" }));

    const file = path.join(configDir, "ystara-client.json");
    expect(run.args).toEqual(["--host", host, "objects", "views", "list", "--space", "SALES", "--secrets-file", file]);
    expect(run.home).toBe(configDir);
    expect(run.secrets).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      token_url: client.tokenUrl,
      authorization_url: "https://synthetic.example.com/oauth/authorize",
      authorization_flow: "client_credentials",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("fills the command cache first, with the same login", async () => {
    const configDir = await mkdtemp(path.join(dir, "tenant-"));
    const cli = new DatasphereCli({ host, bin, client, configDir });
    await expect(cli.initCache()).resolves.toBeUndefined();
    const run = JSON.parse(await cli.exec({ group: "config", verb: "cache-init" }));
    expect(run.args.slice(0, 5)).toEqual(["config", "cache", "init", "--host", host]);
    expect(run.args).toContain("--secrets-file");
  });

  it("uses the machine's own login without a client", async () => {
    const run = JSON.parse(await new DatasphereCli({ host, bin }).exec({ group: "spaces", verb: "list" }));
    expect(run.args).toEqual(["--host", host, "spaces", "list"]);
    expect(run.home).toBe(process.env.HOME);
  });

  it("asks the CLI to log its requests when verbose", async () => {
    const run = JSON.parse(await new DatasphereCli({ host, bin, verbose: true }).exec({ group: "spaces", verb: "list" }));
    expect(run.args).toEqual(["--host", host, "spaces", "list", "--verbose"]);
  });

  it("refuses a client without a folder of its own", () => {
    expect(() => new DatasphereCli({ host, bin, client })).toThrow(/configDir/);
  });

  it("never starts the CLI for a command that is not a read", async () => {
    await rm(path.join(dir, "called"), { force: true });
    const cli = new DatasphereCli({ host, bin });
    // A caller without types, e.g. JavaScript built from user input.
    const write = { group: "objects", kind: "views", verb: "delete" } as unknown as Parameters<DatasphereCli["exec"]>[0];
    await expect(cli.exec(write)).rejects.toThrow(WriteAttemptError);
    expect(existsSync(path.join(dir, "called"))).toBe(false);
  });
});
