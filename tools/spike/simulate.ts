/**
 * Spike for phase 3: can a pipeline's logic run over fixtures without reading
 * any tenant object? Each step becomes one SELECT that reads nothing but
 * DUMMY: tables become fixtures inlined in the statement, SQL views and SQL
 * transformation flows are compiled from their SQL, graphical views from
 * their CSN query (see packages/connector/src/simulate). The definitions come
 * from a saved scan, so compiling sends nothing to the tenant.
 *
 * Usage:
 *   npm run spike:simulate -- --output V_HEADCOUNT_OUT
 *       the newest scan in tools/scan/output; compiles only, nothing is sent
 *   npm run spike:simulate -- --from tools/scan/output/<run> --output HR.V_HEADCOUNT_OUT --run
 *       also runs each step's SELECT through the database user of .env.local
 *       (DSP_DB_HOST, DSP_DB_USER, DSP_DB_PASSWORD, as for npm run spike:sql)
 *   --oracle          with --run: for each view the database user sees (an
 *                     exposed one), also inline the SQL it was deployed as
 *                     (SYS.VIEWS) over the same fixtures and compare the results
 *   --fixtures FILE   fixture rows: a scenario YAML, or a YAML list of { table, rows }
 *   --rows N          made-up rows per table that has no fixture (default 3, at most 9)
 *   --exclude-writer  as for npm run scan; tools/scan/scan.local.json is read too
 *
 * Read-only: the statements sent are SELECTs over DUMMY (the read-only guard
 * checks each one), plus one SELECT on SYS.VIEWS per view with --oracle.
 * The console shows names, counts, timings and the database's first error
 * line. tools/spike/output/simulate-<time>/ (git-ignored) gets report.md, each
 * compiled step's SQL with its values (queries/) and, with --run, up to 20
 * result rows per step (results/), which come from the fixtures.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPipeline, graphFromRaw, SimulationStop, SqlReader, simulatePipeline, type Fragment, type RawObject } from "@ystara/connector";
import { parseFixturesYaml } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";
import { excludeWritersFor, loadScanConfig } from "../scan/config.js";
import { databaseUserFromEnv } from "./database-user.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    output: { type: "string" },
    fixtures: { type: "string" },
    rows: { type: "string" },
    run: { type: "boolean" },
    oracle: { type: "boolean" },
    "exclude-writer": { type: "string", multiple: true },
    config: { type: "string" },
  },
});
if (!values.output) {
  console.error("Name the pipeline's output: npm run spike:simulate -- --output [SPACE.]OBJECT [--from <scan folder>] [--run] [--oracle]");
  process.exit(1);
}

const from = values.from ? path.resolve(values.from) : newestScan();
const saved = JSON.parse(readFileSync(path.join(from, "raw.json"), "utf8")) as { spaces: string[]; raw: RawObject[]; warnings: string[] };
const graph = graphFromRaw(saved.raw, saved.spaces, saved.warnings);
const [space, name] = values.output.includes(".") ? values.output.split(".", 2) : [saved.spaces[0], values.output];
const config = await loadScanConfig(root, values.config);
const pipeline = buildPipeline(graph, { space, technicalName: name }, { excludeWriters: excludeWritersFor(config, space, name, values["exclude-writer"]) });
const fixtures = values.fixtures ? readFixtures(values.fixtures) : undefined;
const sampleRows = Number(values.rows ?? 3);
if (!Number.isInteger(sampleRows) || sampleRows < 0 || sampleRows > 9) {
  console.error("--rows takes a whole number from 0 to 9.");
  process.exit(1);
}
const sim = simulatePipeline(graph, pipeline, { fixtures, sampleRows });

const outDir = path.join(root, "tools", "spike", "output", `simulate-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(path.join(outDir, "queries"), { recursive: true });
const fileOf = (i: number) => `${String(i + 1).padStart(2, "0")}-${sim.steps[i].ref.technicalName.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
const report: string[] = [`# Simulation of ${space}.${name}`, "", `Scan: ${path.relative(root, from)}`, ""];
const line = (text: string) => {
  console.log(text);
  report.push(text);
};

const size = (f: Fragment) => `${(f.sql.length / 1024).toFixed(1)} KB, ${f.params.length} values`;
console.log(`Pipeline for ${space}.${name} from ${path.relative(root, from)}: ${pipeline.steps.length} steps`);
if (pipeline.ambiguousWriters.length) console.log(`Tables with several writers (each gets a fixture): ${pipeline.ambiguousWriters.map((a) => a.table.technicalName).join(", ")}`);
for (const [i, step] of sim.steps.entries()) {
  line(`${String(i + 1).padStart(3)}. ${step.ref.technicalName} (${step.ref.type}): ${step.problem ? `STOPS: ${step.problem}` : step.note}`);
  if (step.query) {
    await writeFile(path.join(outDir, "queries", `${fileOf(i)}.sql`), `${step.query.sql}\n`);
    await writeFile(path.join(outDir, "queries", `${fileOf(i)}.params.json`), `${JSON.stringify(step.query.params, null, 2)}\n`);
  }
}
const tables = new Set(sim.steps.flatMap((s) => [s.ref.technicalName, `${s.ref.space}.${s.ref.technicalName}`]));
const unused = [...(fixtures?.keys() ?? [])].filter((t) => !tables.has(t));
if (unused.length) line(`Fixtures for tables that aren't in the pipeline (not used): ${unused.join(", ")}`);
const compiled = sim.steps.filter((s) => s.query && !s.ref.type.endsWith("table")).length;
const stopped = sim.steps.filter((s) => s.problem).length;
line(
  sim.output
    ? `\nThe output compiled (${size(sim.output)}): ${compiled} step(s) compiled, ${stopped} stopped.`
    : `\nThe output did not compile: ${stopped} step(s) stopped. The first one that stops says why.`,
);

let failures = sim.output ? 0 : 1;
if (values.run) {
  const db = databaseUserFromEnv(root, "--run needs DSP_DB_HOST, DSP_DB_USER and DSP_DB_PASSWORD (as for npm run spike:sql).");
  await mkdir(path.join(outDir, "results"), { recursive: true });
  console.log(`\nRunning each step's SELECT as ${db.user} on ${db.host} (reads DUMMY only):`);
  const sql = await SqlReader.connect(db);
  try {
    for (const [i, step] of sim.steps.entries()) {
      if (!step.query) continue;
      const started = Date.now();
      try {
        const [{ rows }] = await sql.select<{ rows: number }>(`SELECT COUNT(*) AS "rows" FROM (${step.query.sql}) AS "_Q"`, step.query.params);
        const sample = await sql.select(`SELECT * FROM (${step.query.sql}) AS "_Q" LIMIT 20`, step.query.params);
        await writeFile(path.join(outDir, "results", `${fileOf(i)}.json`), `${JSON.stringify(sample, jsonSafe, 2)}\n`);
        line(`  ok    ${step.ref.technicalName}: ${rows} row(s), ${Object.keys(sample[0] ?? {}).length || "?"} column(s), ${Date.now() - started} ms`);
      } catch (e) {
        failures++;
        line(`  FAIL  ${step.ref.technicalName}: ${firstLine(e, db.password)}`);
      }
    }

    if (values.oracle) {
      console.log("\nComparing each visible view with the SQL it was deployed as (SYS.VIEWS), over the same fixtures:");
      report.push("", "## Compared with the deployed SQL");
      for (const step of sim.steps) {
        if (!step.query || (step.ref.type !== "sql_view" && step.ref.type !== "graphical_view")) continue;
        try {
          const [view] = await sql.select<{ definition: unknown }>('SELECT DEFINITION AS "definition" FROM SYS.VIEWS WHERE SCHEMA_NAME = ? AND VIEW_NAME = ?', [step.ref.space, step.ref.technicalName]);
          if (!view) {
            line(`  -     ${step.ref.technicalName}: the database user doesn't see it (not exposed)`);
            continue;
          }
          const deployedSql = Buffer.isBuffer(view.definition) ? view.definition.toString("utf8") : String(view.definition);
          await writeFile(path.join(outDir, "queries", `deployed-${step.ref.technicalName.replace(/[^A-Za-z0-9_.-]/g, "_")}.sql`), `${deployedSql}\n`);
          let deployed: Fragment;
          try {
            deployed = sim.inline(step.ref, deployedSql);
          } catch (e) {
            if (!(e instanceof SimulationStop)) throw e;
            line(`  -     ${step.ref.technicalName}: its deployed SQL can't be inlined: ${e.message}`);
            continue;
          }
          const ours = await sql.select(`SELECT * FROM (${step.query.sql}) AS "_Q"`, step.query.params);
          const theirs = await sql.select(`SELECT * FROM (${deployed.sql}) AS "_Q"`, deployed.params);
          const verdict = compareResults(ours, theirs);
          if (!verdict.same) {
            failures++;
            const both = { compiled: ours.slice(0, 50), deployed: theirs.slice(0, 50) };
            await writeFile(path.join(outDir, "results", `oracle-${step.ref.technicalName.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`), `${JSON.stringify(both, jsonSafe, 2)}\n`);
          }
          line(`  ${verdict.same ? "same " : "DIFF "} ${step.ref.technicalName}: ${verdict.text}`);
        } catch (e) {
          failures++;
          line(`  FAIL  ${step.ref.technicalName}: ${firstLine(e, db.password)}`);
        }
      }
    }
  } finally {
    await sql.close();
  }
}

await writeFile(path.join(outDir, "report.md"), `${report.join("\n")}\n`);
console.log(`\nSaved to ${path.relative(root, outDir)}`);
if (failures) process.exitCode = 1;

/** Fixture rows by table from a YAML file. CSV files aren't read yet, so a fixture that names one stops the spike. */
function readFixtures(file: string) {
  const list = parseFixturesYaml(readFileSync(path.resolve(file), "utf8"));
  const csv = list.filter((f) => f.csv).map((f) => f.table);
  if (csv.length) {
    console.error(`The spike doesn't read CSV fixtures yet: give rows for ${csv.join(", ")} in the YAML.`);
    process.exit(1);
  }
  return new Map(list.map((f) => [f.table, f.rows ?? []]));
}

/** The newest scan folder with a raw.json. */
function newestScan(): string {
  const dir = path.join(root, "tools", "scan", "output");
  const runs = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "raw.json"))).sort() : [];
  if (!runs.length) {
    console.error("No saved scan in tools/scan/output. Run npm run scan -- --space <SPACE> first, or give --from.");
    process.exit(1);
  }
  return path.join(dir, runs.at(-1)!);
}

function firstLine(e: unknown, password: string): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0].split(password).join("<password>");
}

/** Values as JSON can hold them: binary in hex, the rest as the driver gave it. */
function jsonSafe(_key: string, value: unknown) {
  return value && typeof value === "object" && (value as { type?: string }).type === "Buffer" ? Buffer.from((value as { data: number[] }).data).toString("hex") : value;
}

/** Two results as sets of rows (order ignored): the same columns and the same rows. */
function compareResults(ours: Record<string, unknown>[], theirs: Record<string, unknown>[]) {
  const columns = (rows: Record<string, unknown>[]) => Object.keys(rows[0] ?? {}).sort().join(", ");
  const canonical = (rows: Record<string, unknown>[]) =>
    rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]), jsonSafe)).sort();
  if (ours.length && theirs.length && columns(ours) !== columns(theirs)) {
    return { same: false, text: `other columns: compiled ${columns(ours)}; deployed ${columns(theirs)}` };
  }
  const a = canonical(ours);
  const b = canonical(theirs);
  if (a.length === b.length && a.every((row, i) => row === b[i])) return { same: true, text: `${a.length} row(s), the same` };
  const onlyOurs = a.filter((row) => !b.includes(row)).length;
  return { same: false, text: `compiled ${a.length} row(s), deployed ${b.length}; ${onlyOurs} of ours aren't in theirs (both in results/oracle-*.json)` };
}
