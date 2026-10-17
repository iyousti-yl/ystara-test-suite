import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliOutputError, DatasphereCli, parseListing } from "./cli.js";
import { WriteAttemptError } from "./readonly.js";

// Stand-ins for the Datasphere CLI, written in Node. Shell scripts, so not on Windows.
describe.skipIf(process.platform === "win32")("Datasphere CLI wrapper", () => {
  let dir: string;
  let bin: string;
  let asks: string;
  let plain: string;
  let wrongShape: string;
  let cacheError: string;
  const host = "https://synthetic.example.com";
  const client = { clientId: "client-id", clientSecret: "client-secret", tokenUrl: "https://synthetic.example.com/oauth/token" };

  /** Writes a stand-in that runs `body` with `fs`, `args` (its arguments) and `secrets` (the secrets file, if given). */
  async function standIn(name: string, body: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(
      file,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("--secrets-file");
const secrets = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], "utf8")) : null;
${body}
`,
    );
    await chmod(file, 0o755);
    return file;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ystara-cli-"));
    // Like the real CLI: a --host before the command words is ignored, and without a host it asks for one and exits 0.
    // Otherwise it prints what it was started with: for a list, as the one item of the list.
    bin = await standIn(
      "fake-datasphere",
      `fs.writeFileSync(${JSON.stringify(path.join(dir, "called"))}, "yes");
let start = 0;
while (args[start] && args[start].startsWith("--")) start += 2;
if (!args.slice(start).includes("--host")) {
  console.log("? URL of the system to connect to");
  process.exit(0);
}
const started = { technicalName: "STAND_IN", args, home: process.env.HOME, secrets };
console.log(JSON.stringify(args.includes("list") ? [started] : started));`,
    );
    // A CLI that asks a question whatever it is given and waits for the answer until its input ends, like a real prompt.
    // It logs the secret on stderr while doing so.
    asks = await standIn(
      "asks",
      `console.error("token request for " + (secrets && secrets.client_secret));
console.log("? URL of the system to connect to");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));`,
    );
    // A CLI that answers in words instead of JSON, with the secret in them.
    plain = await standIn("plain", `console.log("Signed in with " + (secrets && secrets.client_secret) + ". No objects.");`);
    // A CLI that answers in JSON of the wrong shape: an error object for a list, a list for a read.
    wrongShape = await standIn("wrong-shape", `console.log(JSON.stringify(args.includes("list") ? { error: "Space not found" } : ["not", "a", "definition"]));`);
    // A CLI that reports a failed login while filling its cache, with exit code 0.
    cacheError = await standIn(
      "cache-error",
      `console.error("POST token client_secret=" + (secrets && secrets.client_secret));
console.error("Error: Request failed with status code 401 (Unauthorized)");`,
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** What the stand-in was started with, from what it printed. */
  const started = (out: string) => {
    const json = JSON.parse(out) as unknown;
    return (Array.isArray(json) ? json[0] : json) as { args: string[]; home: string; secrets: unknown };
  };

  it("logs in with a technical client through a secrets file in the tenant's own folder", async () => {
    const configDir = await mkdtemp(path.join(dir, "tenant-"));
    const cli = new DatasphereCli({ host, bin, client, configDir });
    const run = started(await cli.exec({ group: "objects", kind: "views", verb: "list" }, { space: "SALES" }));

    const file = path.join(configDir, "ystara-client.json");
    expect(run.args).toEqual(["objects", "views", "list", "--space", "SALES", "--host", host, "--secrets-file", file]);
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
    const run = started(await cli.exec({ group: "config", verb: "cache-init" }));
    expect(run.args).toEqual(["config", "cache", "init", "--host", host, "--secrets-file", path.join(configDir, "ystara-client.json")]);
  });

  it("uses the machine's own login without a client", async () => {
    const cli = new DatasphereCli({ host, bin });
    const run = started(await cli.exec({ group: "objects", kind: "local-tables", verb: "list" }, { space: "HR", top: "1000" }));
    expect(run.args).toEqual(["objects", "local-tables", "list", "--space", "HR", "--top", "1000", "--host", host]);
    expect(run.home).toBe(process.env.HOME);
    await expect(cli.listObjects("HR", "views", 1)).resolves.toEqual([{ technicalName: "STAND_IN", businessName: undefined }]);
  });

  it("asks the CLI to log its requests when verbose", async () => {
    const cli = new DatasphereCli({ host, bin, verbose: true });
    const run = started(await cli.exec({ group: "objects", kind: "views", verb: "read" }, { space: "HR", "technical-name": "V_HEADCOUNT" }));
    expect(run.args).toEqual(["objects", "views", "read", "--space", "HR", "--technical-name", "V_HEADCOUNT", "--host", host, "--verbose"]);
  });

  it("fails when the CLI asks a question instead of answering, even with exit code 0, and never quotes the secret", async () => {
    // A short timeout: the CLI gets no input, so it must stop at once instead of waiting for an answer.
    const cli = new DatasphereCli({ host, bin: asks, client, configDir: await mkdtemp(path.join(dir, "tenant-")), timeoutMs: 5_000 });
    const error = await cli.listObjects("HR", "views").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliOutputError);
    const { message, output } = error as CliOutputError;
    expect(message).toBe(
      'datasphere objects views list asked "URL of the system to connect to" instead of answering. Ystara gives the CLI no input: check the host and the login.',
    );
    expect(output).toContain("token request for <secret>");
    expect(`${message}\n${output}`).not.toContain(client.clientSecret);
    // Filling the cache prints no JSON, but a question is a failure there too.
    await expect(cli.initCache()).rejects.toThrow(/^datasphere config cache init asked "URL of the system to connect to" instead of answering/);
  });

  it("fails when a list or read prints something other than JSON, even with exit code 0, and never quotes the secret", async () => {
    const cli = new DatasphereCli({ host, bin: plain, client, configDir: await mkdtemp(path.join(dir, "tenant-")) });
    for (const run of [() => cli.listObjects("HR", "local-tables"), () => cli.readObject("HR", "views", "V_HEADCOUNT")]) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliOutputError);
      const { message, output } = error as CliOutputError;
      expect(message).toMatch(/^datasphere objects (local-tables list|views read) printed "Signed in with <secret>\. No objects\." instead of JSON\.$/);
      expect(`${message}\n${output}`).not.toContain(client.clientSecret);
    }
    // Filling the cache needs no JSON.
    await expect(cli.initCache()).resolves.toBeUndefined();
  });

  it("fails when a list or read prints JSON of another shape, even with exit code 0", async () => {
    const cli = new DatasphereCli({ host, bin: wrongShape });
    await expect(cli.listObjects("HR", "views", 1)).rejects.toThrow('datasphere objects views list printed JSON that isn\'t a list: "{"error":"Space not found"}".');
    await expect(cli.readObject("HR", "views", "V_HEADCOUNT")).rejects.toThrow(
      'datasphere objects views read printed JSON that isn\'t an object definition: "["not","a","definition"]".',
    );
  });

  it("fails when filling the cache reports an error, even with exit code 0, and never quotes the secret", async () => {
    const cli = new DatasphereCli({ host, bin: cacheError, client, configDir: await mkdtemp(path.join(dir, "tenant-")) });
    const error = await cli.initCache().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliOutputError);
    const { message, output } = error as CliOutputError;
    expect(message).toBe('datasphere config cache init reported "Error: Request failed with status code 401 (Unauthorized)".');
    expect(output).toContain("client_secret=<secret>");
    expect(output).not.toContain(client.clientSecret);
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

describe("parseListing", () => {
  it("takes a list of names or of objects with a name", () => {
    expect(parseListing('["A_ONE", {"technicalName": "B_TWO", "businessName": "Two"}, {"name": "C_THREE"}]')).toEqual([
      { technicalName: "A_ONE" },
      { technicalName: "B_TWO", businessName: "Two" },
      { technicalName: "C_THREE", businessName: undefined },
    ]);
  });

  it("refuses anything else instead of reading it as an empty list", () => {
    expect(() => parseListing('{"error": "Space not found"}')).toThrow("Not a listing: JSON that isn't a list.");
    expect(() => parseListing('[{"error": "Space not found"}]')).toThrow("Not a listing: a list with an item that has no name.");
  });
});
