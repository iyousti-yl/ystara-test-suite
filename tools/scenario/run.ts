/**
 * Runs a scenario (phase 3a): a YAML file with test rows for a pipeline's
 * tables and the results expected at its steps (packages/shared/src/scenario.ts).
 * The pipeline's logic is compiled from a saved scan, over the scenario's rows
 * only (packages/connector/src/simulate), so nothing is loaded into or run in
 * the tenant: each check is one SELECT that reads nothing but DUMMY.
 *
 * Usage:
 *   npm run scenario:run -- --file tools/scenario/region-totals.local.yaml
 *       compiles the scenario over the newest scan in tools/scan/output, runs
 *       each check through the database user of .env.local (DSP_DB_HOST,
 *       DSP_DB_USER, DSP_DB_PASSWORD, as for npm run spike:sql) and prints
 *       pass or FAIL for each
 *   --compile-only    compile and list the checks, send nothing
 *   --from <scan folder>, --config, --exclude-writer   as for npm run spike:simulate
 *
 * A scenario written for a real tenant names its objects, so keep it in a
 * file ending in .local.yaml, which git ignores. Exit code 1 when a check
 * fails, errors, or can't run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPipeline, planScenario, runScenario, SqlReader, type CheckStatus } from "@ystara/connector";
import { parseScenarioYaml, scenarioProblems, type ScenarioSpec } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";
import { excludeWritersFor, loadScanConfig } from "../scan/config.js";
import { loadSavedScan, objectIn } from "../scan/saved.js";
import { databaseUserFromEnv } from "../spike/database-user.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    from: { type: "string" },
    "compile-only": { type: "boolean" },
    "exclude-writer": { type: "string", multiple: true },
    config: { type: "string" },
  },
});
if (!values.file) {
  console.error("Name the scenario: npm run scenario:run -- --file <scenario.yaml> [--from <scan folder>] [--compile-only]");
  process.exit(1);
}

let spec: ScenarioSpec;
try {
  spec = parseScenarioYaml(readFileSync(path.resolve(values.file), "utf8"));
} catch (e) {
  console.error(`${values.file} isn't a valid scenario:`);
  for (const problem of scenarioProblems(e)) console.error(`  - ${problem}`);
  process.exit(1);
}

const { from, spaces, graph } = loadSavedScan(root, values.from);
const { space, technicalName } = objectIn(spaces, spec.pipeline);
if (!graph.nodes.some((n) => n.space === space && n.technicalName === technicalName)) {
  console.error(`${space}.${technicalName}, the scenario's pipeline, isn't in the scan ${path.relative(root, from)}.`);
  process.exit(1);
}
const config = await loadScanConfig(root, values.config);
const pipeline = buildPipeline(graph, { space, technicalName }, { excludeWriters: excludeWritersFor(config, space, technicalName, values["exclude-writer"]) });
const plan = planScenario(graph, pipeline, spec);

console.log(`Scenario "${spec.name}" (${spec.kind}) on ${space}.${technicalName}, from ${path.relative(root, from)}: ${pipeline.steps.length} steps`);
for (const step of plan.simulation.steps) console.log(`  ${step.ref.technicalName}: ${step.problem ? `STOPS: ${step.problem}` : step.note}`);
if (plan.problems.length) {
  console.log("\nThe scenario can't run, so nothing is sent:");
  for (const problem of plan.problems) console.log(`  - ${problem}`);
}

const MARKS: Record<CheckStatus | "compiled", string> = { pass: "pass ", fail: "FAIL ", error: "ERROR", not_run: "-    ", compiled: "ok   " };
const print = (status: CheckStatus | "compiled", checkpoint: string, label: string, detail: string) => console.log(`  ${MARKS[status]} ${checkpoint}  ${label}: ${detail}`);

if (values["compile-only"] || plan.problems.length) {
  console.log(`\n${plan.checks.length} check(s)${values["compile-only"] ? ", compiled only, nothing sent" : ""}:`);
  for (const c of plan.checks) {
    const size = c.query ? `compiled (${(c.query.sql.length / 1024).toFixed(1)} KB, ${c.query.params.length} values)` : (c.problem ?? "");
    print(c.query ? "compiled" : "not_run", c.checkpoint, c.label, size);
  }
  process.exitCode = plan.problems.length || plan.checks.some((c) => !c.query) ? 1 : 0;
} else {
  const db = databaseUserFromEnv(root, "A scenario runs through DSP_DB_HOST, DSP_DB_USER and DSP_DB_PASSWORD (as for npm run spike:sql).");
  console.log(`\nRunning ${plan.checks.length} check(s) as ${db.user} on ${db.host} (reads DUMMY only):`);
  // SqlReader already cuts the password out of its errors; this is a second guard for what reaches the console.
  const masked = (text: string) => text.split(db.password).join("<password>");
  let sql: SqlReader;
  try {
    sql = await SqlReader.connect(db);
  } catch (e) {
    console.error(`Couldn't sign in as ${db.user} on ${db.host}: ${masked((e instanceof Error ? e.message : String(e)).split("\n")[0])}`);
    process.exit(1);
  }
  try {
    const results = await runScenario(plan, (query) => sql.select(query.sql, query.params));
    for (const r of results) print(r.status, r.checkpoint, r.label, masked(r.detail));
    const passed = results.filter((r) => r.status === "pass").length;
    console.log(`\n${passed} of ${results.length} check(s) passed.`);
    if (passed < results.length) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}
