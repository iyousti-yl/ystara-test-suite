#!/usr/bin/env node
/**
 * Feasibility spike: what can the installed Datasphere CLI do on this tenant?
 *
 * Answers the phase 1 risk questions from the master plan:
 *   1. Which object kinds can be listed and read?
 *   2. Which can be created (deployed) into the test space?
 *   3. Can a task chain be started from the CLI?
 *   4. How long does a full space export take (sizing for scans)?
 *
 * It only touches the space named in DSP_SPACE. By default it is read-only:
 * question 2 runs only with DSP_SPIKE_DEPLOY=1, which creates objects prefixed
 * YSTARA_SPIKE_ and deletes them at the end. Run it against the partner tenant
 * with their written permission, never against a client tenant.
 *
 * Usage: fill DSP_* in .env, then `npm run spike:cli`.
 * Output: tools/spike/output/<timestamp>.json plus a console summary.
 */
import { execa } from "execa";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows pathname is "/C:/...", which resolves to C:\C:\...
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
await loadDotEnv(path.join(root, ".env"));

const HOST = must("DSP_HOST");
const SPACE = must("DSP_SPACE");
const BIN = process.env.DSP_CLI_BIN ?? "datasphere";
const DEPLOY = process.env.DSP_SPIKE_DEPLOY === "1";
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

const results = { startedAt: new Date().toISOString(), host: HOST, space: SPACE, cliVersion: null, kinds: {}, deploy: {}, taskChain: null, timings: {} };

results.cliVersion = (await tryRun(["--version"])).stdout?.trim() ?? null;
console.log(`CLI version: ${results.cliVersion ?? "not found (npm i -g @sap/datasphere-cli)"}`);

// 1 + 4: list and read each kind, timing the whole thing
const t0 = Date.now();
for (const kind of OBJECT_KINDS) {
  const list = await tryRun(["--host", HOST, "objects", kind, "list", "--space", SPACE, "--top", LIST_TOP]);
  const entry = { list: list.ok, count: null, read: null, error: list.ok ? null : firstLine(list.stderr) };
  if (list.ok) {
    let items = [];
    try { items = JSON.parse(list.stdout); } catch { /* some versions print tables; keep raw */ }
    entry.count = Array.isArray(items) ? items.length : null;
    const first = Array.isArray(items) && items[0] ? (items[0].technicalName ?? items[0].name ?? items[0]) : null;
    if (first) {
      const read = await tryRun(["--host", HOST, "objects", kind, "read", "--space", SPACE, "--technical-name", String(first)]);
      entry.read = read.ok;
      if (!read.ok) entry.error = firstLine(read.stderr);
    }
  }
  results.kinds[kind] = entry;
  console.log(`${kind.padEnd(22)} list=${mark(entry.list)} read=${mark(entry.read)} count=${entry.count ?? "?"}${entry.error ? "  " + entry.error : ""}`);
}
results.timings.fullListAndReadMs = Date.now() - t0;

// 2: can we create a local table and an SQL view on top of it?
const tableName = "YSTARA_SPIKE_T1";
const viewName = "YSTARA_SPIKE_V1";
const tableDef = {
  definitions: {
    [tableName]: {
      kind: "entity",
      elements: {
        ID: { type: "cds.String", length: 10, key: true },
        AMOUNT: { type: "cds.Decimal", precision: 15, scale: 2 },
      },
      "@EndUserText.label": "Ystara spike table",
    },
  },
};
const viewDef = {
  definitions: {
    [viewName]: {
      kind: "entity",
      query: { SELECT: { from: { ref: [tableName] }, columns: [{ ref: ["ID"] }, { ref: ["AMOUNT"] }] } },
      "@EndUserText.label": "Ystara spike view",
      "@DataWarehouse.consumption.external": true,
    },
  },
};
if (DEPLOY) {
  results.deploy.localTable = await deploy("local-tables", tableName, tableDef);
  results.deploy.sqlView = await deploy("views", viewName, viewDef);
} else {
  results.deploy = { skipped: true, reason: "read-only run; set DSP_SPIKE_DEPLOY=1 to test create/delete" };
}

// 3: can a task chain be started? Uses the first existing chain, if any, and does NOT run it unless DSP_SPIKE_RUN_CHAIN=1.
const chains = results.kinds["task-chains"];
if (chains?.list && chains.count > 0 && process.env.DSP_SPIKE_RUN_CHAIN === "1") {
  const list = await tryRun(["--host", HOST, "objects", "task-chains", "list", "--space", SPACE]);
  const first = JSON.parse(list.stdout)[0];
  const name = first.technicalName ?? first.name;
  const run = await tryRun(["--host", HOST, "tasks", "chains", "run", "--space", SPACE, "--object", String(name)]);
  results.taskChain = { name, started: run.ok, detail: firstLine(run.ok ? run.stdout : run.stderr) };
} else {
  results.taskChain = { skipped: true, reason: "no chain found or DSP_SPIKE_RUN_CHAIN not set" };
}

// Cleanup (only what this run created)
for (const [kind, name] of DEPLOY ? [["views", viewName], ["local-tables", tableName]] : []) {
  const del = await tryRun(["--host", HOST, "objects", kind, "delete", "--space", SPACE, "--technical-name", name, "--force"]);
  results.deploy[`cleanup_${kind}`] = del.ok;
}

results.finishedAt = new Date().toISOString();
const outDir = path.join(root, "tools", "spike", "output");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${results.startedAt.replace(/[:.]/g, "-")}.json`);
await writeFile(outFile, JSON.stringify(results, null, 2));
console.log(`\nSaved ${path.relative(root, outFile)}`);
console.log(`Deploy: ${DEPLOY ? `table=${mark(results.deploy.localTable?.ok)} view=${mark(results.deploy.sqlView?.ok)}` : "skipped (read-only)"}  Task chain: ${JSON.stringify(results.taskChain)}`);

// ---- helpers ----
async function deploy(kind, name, def) {
  const file = path.join(root, "tools", "spike", `.${name}.json`);
  await writeFile(file, JSON.stringify(def));
  const r = await tryRun(["--host", HOST, "objects", kind, "create", "--space", SPACE, "--file-path", file]);
  return { ok: r.ok, detail: firstLine(r.ok ? r.stdout : r.stderr) };
}
async function tryRun(args) {
  try {
    const r = await execa(BIN, args, { reject: false, timeout: 120_000 });
    return { ok: r.exitCode === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e?.message ?? e) };
  }
}
function must(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name} in .env`); process.exit(1); }
  return v;
}
function mark(v) { return v === true ? "yes" : v === false ? "no" : "-"; }
function firstLine(s) { return (s ?? "").split("\n").find((l) => l.trim()) ?? ""; }
async function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
