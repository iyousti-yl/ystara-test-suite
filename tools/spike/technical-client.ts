/**
 * Spike for phase 1e: can a technical OAuth client read a space, so the
 * worker can scan with nobody present?
 *
 * Strictly read-only: it fills the CLI's local command cache, tries to list
 * the tenant's spaces, checks that each given space is readable, then lists
 * every kind of object a scan reads (views, local and remote tables, flows,
 * task chains, ...) and reads the first of each, all through the connector's
 * read-only gate. Nothing is created or changed in the tenant.
 *
 * To find the smallest role that is enough, run it once per client (e.g. one
 * with broad roles, one with only a Viewer scoped role) and compare the counts
 * per kind it prints at the end: a kind that one client lists and the other
 * can't, or lists as 0, is hidden by that client's role.
 *
 * Before running it, in the tenant (an admin does this once):
 *   1. System > Administration > App Integration > Add a New OAuth Client,
 *      purpose "Technical User". Note its client ID, secret and the token URL
 *      shown on that page.
 *   2. Add the technical user to each space as a member, with a scoped role
 *      that can read the space's objects (e.g. Viewer).
 * Then put in .env.local (never in .env or a committed file):
 *   DSP_HOST, DSP_SPACE (one or more space IDs, separated by commas),
 *   DSP_CLIENT_ID, DSP_CLIENT_SECRET, DSP_TOKEN_URL
 * and run `npm run spike:technical-client`.
 *
 * Listing spaces only warns when it fails: it needs a tenant-wide privilege
 * that a client with a role in its spaces doesn't have, and Ystara doesn't
 * need it. Each space is checked by its ID instead.
 *
 * `npm run spike:technical-client -- --verbose` has the CLI log its requests,
 * for a failure that doesn't say why. It is off by default because those log
 * lines can land in the CLI's answer and fail the check that it is JSON.
 *
 * It uses a temporary CLI folder, so your own `datasphere login` is neither
 * used nor touched, and deletes that folder (with the token) at the end.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLI_OBJECT_KINDS, CliOutputError, DatasphereCli, maskSecrets, parseListing } from "@ystara/connector";
import { loadLocalEnv } from "@ystara/shared/env";

loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

const { verbose } = parseArgs({ options: { verbose: { type: "boolean", default: false } } }).values;

const env = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is missing in .env.local. This spike needs DSP_HOST, DSP_SPACE, DSP_CLIENT_ID, DSP_CLIENT_SECRET and DSP_TOKEN_URL.`);
    process.exit(1);
  }
  return value;
};
const host = env("DSP_HOST");
const spaces = env("DSP_SPACE").split(",").map((s) => s.trim()).filter(Boolean);
const client = { clientId: env("DSP_CLIENT_ID"), clientSecret: env("DSP_CLIENT_SECRET"), tokenUrl: env("DSP_TOKEN_URL") };

const configDir = await mkdtemp(path.join(tmpdir(), "ystara-spike-"));
const cli = new DatasphereCli({ host, bin: process.env.DSP_CLI_BIN, client, configDir, verbose });
let failures = 0;

/**
 * Runs one step and prints how it went and how long it took. A failure fails
 * the spike, unless the step is `optional`: then it only warns, saying why
 * that doesn't matter. `failure` names what a failure means, e.g. "not readable".
 */
async function step<T>(
  name: string,
  run: () => Promise<T>,
  describe: (result: T) => string,
  opts: { optional?: string; failure?: string } = {},
): Promise<T | undefined> {
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  try {
    const result = await run();
    console.log(`ok    ${name} (${took()}): ${describe(result)}`);
    return result;
  } catch (e) {
    const { reason, printed } = explain(e);
    if (opts.optional) {
      console.log(`warn  ${name} (${took()}): ${opts.optional}\n      ${printed.at(-1) ?? reason}`);
    } else {
      failures++;
      console.log(`FAIL  ${name} (${took()}): ${[opts.failure, reason].filter(Boolean).join(": ")}`);
      if (printed.length) console.log(`      The CLI's last lines:\n${printed.slice(-10).map((l) => `        ${l}`).join("\n")}`);
    }
    return undefined;
  }
}

/** Why a step failed, in one line, and what the CLI printed. Neither holds the client secret. */
function explain(e: unknown): { reason: string; printed: string[] } {
  const hide = (text: string) => maskSecrets(text, client);
  const lines = (...texts: (string | undefined)[]) => hide(texts.filter(Boolean).join("\n")).split("\n").filter((l) => l.trim());
  if (e instanceof CliOutputError) return { reason: e.message, printed: lines(e.output) };
  const err = e as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; message?: string };
  const reason = err.timedOut
    ? "the CLI timed out"
    : err.exitCode !== undefined
      ? `the CLI ended with exit code ${err.exitCode}`
      : hide((err.message ?? String(e)).split("\n")[0]);
  return { reason, printed: lines(err.stdout, err.stderr) };
}

try {
  console.log(`Technical client ${client.clientId} on ${host}, ${spaces.length === 1 ? "space" : "spaces"} ${spaces.join(", ")}${verbose ? " (verbose)" : ""}\n`);
  // Spaces the client can't scan, until it has read them.
  const cannot = new Set(spaces);
  // Per readable space, how many objects of each kind the client lists.
  const counts: string[] = [];
  await step("CLI version", () => cli.version(), (v) => v);
  if (!failures) await step("fill the CLI's command cache with the client", () => cli.initCache(), () => "done");
  if (!failures) {
    await step("list spaces", async () => parseListing(await cli.exec({ group: "spaces", verb: "list" })), (list) => `${list.length} visible`, {
      optional: "needs a tenant-wide privilege; Ystara doesn't need it",
    });

    const readable: string[] = [];
    for (const space of spaces) {
      const seen = await step(
        `space ${space}`,
        async () => [...(await cli.listObjects(space, "views", 1)), ...(await cli.listObjects(space, "local-tables", 1))],
        (found) => (found.length ? "readable" : "readable, but no views or local tables seen: check that the space has some and that the client's role may see them"),
        { failure: "not readable" },
      );
      if (seen) readable.push(space);
    }

    // Every kind a scan reads. A scan carries on without a kind it can't list, with a
    // warning, but its lineage then misses those objects: here that is a failure.
    for (const space of readable) {
      const before = failures;
      const perKind: string[] = [];
      for (const kind of CLI_OBJECT_KINDS) {
        const list = await step(`list ${kind} in ${space}`, () => cli.listObjects(space, kind), (l) => `${l.length}`);
        perKind.push(`${kind} ${list ? list.length : "not listed"}`);
        if (list?.length) {
          const name = list[0].technicalName;
          await step(`read ${kind} ${space}.${name}`, () => cli.readObject(space, kind, name), (o) => `${JSON.stringify(o).length} characters of definition`);
        }
      }
      counts.push(`  ${space}: ${perKind.join(", ")}`);
      if (failures === before) cannot.delete(space);
    }
  }

  if (counts.length) console.log(`\nObjects per kind (run it with another client and compare: a kind one client can't see is hidden by its role):\n${counts.join("\n")}`);

  const can = spaces.filter((s) => !cannot.has(s));
  console.log(
    failures
      ? `\nVerdict: the technical client cannot scan ${[...cannot].join(", ")} yet${can.length ? ` (it can scan ${can.join(", ")})` : ""}. ` +
          `The failures above say why (often its role or space membership).${verbose ? "" : " To see the CLI's requests, run it again with: npm run spike:technical-client -- --verbose"}`
      : `\nVerdict: a technical client can scan ${spaces.join(", ")}.`,
  );
  if (failures) process.exitCode = 1;
} finally {
  await rm(configDir, { recursive: true, force: true });
}
