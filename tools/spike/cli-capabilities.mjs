#!/usr/bin/env node
/**
 * Feasibility spike: what can the installed Datasphere CLI do on this tenant?
 *
 * Answers two phase 1 questions:
 *   1. Which object kinds can be listed and read?
 *   2. How long does listing and reading a space take (sizing for scans)?
 *
 * Strictly read-only: it only runs `list` and `read`. Ystara never creates,
 * changes, deletes or runs anything in a tenant (see docs/architecture).
 *
 * Usage: fill DSP_* in .env.local, then `npm run spike:cli`.
 * Output: tools/spike/output/<timestamp>.json plus a console summary.
 */
import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "@ystara/shared/env";

// fileURLToPath, not URL.pathname: on Windows pathname is "/C:/...", which resolves to C:\C:\...
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const HOST = must("DSP_HOST");
const SPACE = must("DSP_SPACE");
const BIN = process.env.DSP_CLI_BIN ?? "datasphere";
// The CLI lists 25 objects by default; ask for more so counts are usable for sizing.
const LIST_TOP = process.env.DSP_SPIKE_LIST_TOP ?? "1000";
const OBJECT_KINDS = [
  "remote-tables",
  "local-tables",
  "replication-flows",
  "data-flows",
  "transformation-flows",
  "views", // CLI 2026.x merged sql-views and graphical-views into one "views" command
  "analytic-models",
  "task-chains",
  "intelligent-lookups",
];

const results = { startedAt: new Date().toISOString(), host: HOST, space: SPACE, cliVersion: null, kinds: {}, timings: {} };

results.cliVersion = (await tryRun(["--version"])).stdout?.trim() ?? null;
console.log(`CLI version: ${results.cliVersion ?? "not found (npm i -g @sap/datasphere-cli)"}`);

// List and read each kind, timing the whole thing. The host goes after the command: before it, the CLI ignores it.
const t0 = Date.now();
for (const kind of OBJECT_KINDS) {
  const list = await tryRun(["objects", kind, "list", "--space", SPACE, "--top", LIST_TOP, "--host", HOST]);
  const entry = { list: list.ok, count: null, read: null, error: list.ok ? null : firstLine(list.stderr) };
  if (list.ok) {
    let items = [];
    try { items = JSON.parse(list.stdout); } catch { /* some versions print tables; keep raw */ }
    entry.count = Array.isArray(items) ? items.length : null;
    const first = Array.isArray(items) && items[0] ? (items[0].technicalName ?? items[0].name ?? items[0]) : null;
    if (first) {
      const read = await tryRun(["objects", kind, "read", "--space", SPACE, "--technical-name", String(first), "--host", HOST]);
      entry.read = read.ok;
      if (!read.ok) entry.error = firstLine(read.stderr);
    }
  }
  results.kinds[kind] = entry;
  console.log(`${kind.padEnd(22)} list=${mark(entry.list)} read=${mark(entry.read)} count=${entry.count ?? "?"}${entry.error ? "  " + entry.error : ""}`);
}
results.timings.fullListAndReadMs = Date.now() - t0;

results.finishedAt = new Date().toISOString();
const outDir = path.join(root, "tools", "spike", "output");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${results.startedAt.replace(/[:.]/g, "-")}.json`);
await writeFile(outFile, JSON.stringify(results, null, 2));
console.log(`\nSaved ${path.relative(root, outFile)}`);

// ---- helpers ----
async function tryRun(args) {
  try {
    // No input, so the CLI never waits on a question.
    const r = await execa(BIN, args, { reject: false, timeout: 120_000, stdin: "ignore" });
    return { ok: r.exitCode === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e?.message ?? e) };
  }
}
function must(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name} in .env.local`); process.exit(1); }
  return v;
}
function mark(v) { return v === true ? "yes" : v === false ? "no" : "-"; }
function firstLine(s) { return (s ?? "").split("\n").find((l) => l.trim()) ?? ""; }
