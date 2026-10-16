/**
 * Spike for phase 1e: can a technical OAuth client read a space, so the
 * worker can scan with nobody present?
 *
 * Strictly read-only: it fills the CLI's local command cache, lists spaces,
 * lists and reads views and lists local tables in one space, all through the
 * connector's read-only gate. Nothing is created or changed in the tenant.
 *
 * Before running it, in the tenant (an admin does this once):
 *   1. System > Administration > App Integration > Add a New OAuth Client,
 *      purpose "Technical User". Note its client ID, secret and the token URL
 *      shown on that page.
 *   2. Add the technical user to the space as a member, with the least role
 *      that can see its objects.
 * Then put in .env.local (never in .env or a committed file):
 *   DSP_HOST, DSP_SPACE, DSP_CLIENT_ID, DSP_CLIENT_SECRET, DSP_TOKEN_URL
 * and run `npm run spike:technical-client`.
 *
 * It uses a temporary CLI folder, so your own `datasphere login` is neither
 * used nor touched, and deletes that folder (with the token) at the end.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatasphereCli, parseListing } from "@ystara/connector";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const env = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is missing in .env.local. This spike needs DSP_HOST, DSP_SPACE, DSP_CLIENT_ID, DSP_CLIENT_SECRET and DSP_TOKEN_URL.`);
    process.exit(1);
  }
  return value;
};
const host = env("DSP_HOST");
const space = env("DSP_SPACE");
const client = { clientId: env("DSP_CLIENT_ID"), clientSecret: env("DSP_CLIENT_SECRET"), tokenUrl: env("DSP_TOKEN_URL") };

const configDir = await mkdtemp(path.join(tmpdir(), "ystara-spike-"));
// Verbose, so a failure shows the request that failed and its status, not only "failed".
const cli = new DatasphereCli({ host, bin: process.env.DSP_CLI_BIN, client, configDir, verbose: true });
let failed = false;

/** Runs one step, prints how it went and how long it took, and stops at the first failure. */
async function step<T>(name: string, run: () => Promise<T>, describe: (result: T) => string): Promise<T | undefined> {
  if (failed) return undefined;
  const started = Date.now();
  try {
    const result = await run();
    console.log(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)} s): ${describe(result)}`);
    return result;
  } catch (e) {
    failed = true;
    const err = e as { stderr?: string; stdout?: string; shortMessage?: string; message?: string };
    const text = [err.stdout, err.stderr].filter(Boolean).join("\n") || err.shortMessage || err.message || String(e);
    const lines = text.replaceAll(client.clientSecret, "<secret>").split("\n").filter((l) => l.trim());
    console.log(`FAIL  ${name}, the CLI's last lines:\n${lines.slice(-10).map((l) => `      ${l}`).join("\n")}`);
    return undefined;
  }
}

try {
  console.log(`Technical client ${client.clientId} on ${host}, space ${space}\n`);
  await step("CLI version", () => cli.version(), (v) => v);
  await step("fill the CLI's command cache with the client", () => cli.initCache(), () => "done");
  const spaces = await step(
    "list spaces",
    async () => parseListing(await cli.exec({ group: "spaces", verb: "list" })),
    (list) => `${list.length} visible${list.some((s) => s.technicalName === space) ? `, including ${space}` : `; ${space} is NOT among them`}`,
  );
  const views = await step("list views", () => cli.listObjects(space, "views"), (list) => `${list.length} views`);
  if (views?.length) await step(`read view ${views[0].technicalName}`, () => cli.readObject(space, "views", views[0].technicalName), (o) => `${JSON.stringify(o).length} characters of definition`);
  await step("list local tables", () => cli.listObjects(space, "local-tables"), (list) => `${list.length} local tables`);

  console.log(
    failed
      ? "\nVerdict: the technical client cannot scan this space yet. The first failure above says why (often its role or space membership)."
      : `\nVerdict: a technical client can scan ${space}.${spaces && views?.length === 0 ? " It saw no views: check that the space has some and that the client's role may see them." : ""}`,
  );
  if (failed) process.exitCode = 1;
} finally {
  await rm(configDir, { recursive: true, force: true });
}
