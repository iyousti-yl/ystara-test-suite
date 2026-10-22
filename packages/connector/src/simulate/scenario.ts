import { refKey, TABLE_TYPES, type Assertion, type DspObjectRef, type LineageGraph, type Pipeline, type ScenarioSpec } from "@ystara/shared";
import { assertSelectOnly, NotSelectError } from "../readonly.js";
import { quoteIdentifier, type Row } from "../sql.js";
import type { Cell } from "./fixtures.js";
import { concat, SimulationStop, type Fragment } from "./fragment.js";
import { assertSendable, simulatePipeline, type SimulatedStep, type Simulation } from "./simulate.js";
import { tokenize } from "./sql-text.js";

/**
 * A scenario (phase 3) run as a simulation. Its fixtures stand in for the
 * pipeline's tables, and a table it gives no rows for is empty, so a result
 * depends only on what the scenario says. Each assertion becomes one SELECT
 * over its checkpoint's compiled query, which reads nothing but DUMMY.
 *
 * `planScenario` compiles everything and sends nothing: what it can't place
 * (a fixture for a table outside the pipeline, a checkpoint that can't be
 * simulated, ...) comes back in words. `runScenario` sends each check through
 * `select` and judges what comes back.
 */

export interface ScenarioCheck {
  /** The checkpoint as the scenario names it. */
  checkpoint: string;
  step?: DspObjectRef;
  assertion: Assertion;
  /** The assertion in a few words: `row_count = 1`, `unique EMP_ID`. */
  label: string;
  query?: Fragment;
  /** Why this check can't be run. */
  problem?: string;
}

export interface ScenarioPlan {
  simulation: Simulation;
  /** What keeps the whole scenario from running, such as a fixture for a table that isn't in the pipeline. */
  problems: string[];
  checks: ScenarioCheck[];
}

export type CheckStatus = "pass" | "fail" | "error" | "not_run";

export interface CheckResult extends ScenarioCheck {
  status: CheckStatus;
  /** What came back, or why the check didn't run. */
  detail: string;
}

/** The most rows `rows_equal` reads from a checkpoint. A scenario's result is small; a larger one means the check is too broad. */
export const MAX_COMPARED_ROWS = 10_000;

export function planScenario(graph: LineageGraph, pipeline: Pipeline, spec: ScenarioSpec): ScenarioPlan {
  const problems: string[] = [];
  const nodes = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const steps = pipeline.steps.map((s) => nodes.get(refKey(s))!);
  const find = (name: string) => {
    const found = steps.filter((s) => (name.includes(".") ? refKey(s) === name : s.technicalName === name));
    return found.length === 1 ? { step: found[0] } : { problem: found.length ? `${name} is in several spaces; write it as SPACE.${name}` : undefined };
  };

  const fixtures = new Map<string, Record<string, Cell>[]>();
  for (const f of spec.fixtures) {
    const { step, problem } = find(f.table);
    if (!step) {
      problems.push(problem ?? `The test rows for ${f.table} name no table of the pipeline.`);
    } else if (!TABLE_TYPES.has(step.type)) {
      problems.push(`${f.table} is a ${step.type.replace(/_/g, " ")}: test rows stand in for tables, so give rows to the tables it reads.`);
    } else if (f.csv) {
      problems.push(`The test rows for ${f.table} come from a CSV file, which isn't supported yet: give its rows in the scenario.`);
    } else if (fixtures.has(refKey(step))) {
      problems.push(`${f.table} is given test rows twice.`);
    } else {
      fixtures.set(refKey(step), f.rows ?? []);
    }
  }

  const simulation = simulatePipeline(graph, pipeline, { fixtures, withoutFixture: "empty" });
  const simulated = new Map<string, SimulatedStep>(simulation.steps.map((s) => [refKey(s.ref), s]));
  // A fixture that can't be used (a column the table doesn't have) is the scenario's mistake, not the pipeline's.
  for (const key of fixtures.keys()) {
    const problem = simulated.get(key)?.problem;
    if (problem) problems.push(`${problem[0].toUpperCase()}${problem.slice(1)}.`);
  }
  const checks: ScenarioCheck[] = [];
  for (const expectation of spec.expect) {
    const { step, problem } = find(expectation.checkpoint);
    const sim = step ? simulated.get(refKey(step)) : undefined;
    for (const assertion of expectation.assertions) {
      const check: ScenarioCheck = { checkpoint: expectation.checkpoint, step: sim?.ref, assertion, label: labelOf(assertion) };
      if (!sim) check.problem = problem ?? `${expectation.checkpoint} isn't a step of the pipeline.`;
      else if (sim.problem) check.problem = `${expectation.checkpoint} can't be simulated: ${sim.problem}`;
      else if (!sim.query) check.problem = `${expectation.checkpoint} is a ${sim.ref.type.replace(/_/g, " ")}, which holds no rows: check the table it loads.`;
      else {
        try {
          check.query = checkQuery(assertion, sim.query);
          assertSendable(check.query);
        } catch (e) {
          if (!(e instanceof SimulationStop)) throw e;
          check.problem = e.message;
          check.query = undefined;
        }
      }
      checks.push(check);
    }
  }
  return { simulation, problems, checks };
}

/** Sends each check through `select` (one SELECT each) and judges its result. Nothing is sent while the scenario has problems. */
export async function runScenario(plan: ScenarioPlan, select: (query: Fragment) => Promise<Row[]>): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of plan.checks) {
    if (plan.problems.length) {
      results.push({ ...check, status: "not_run", detail: "not run, because the scenario has problems" });
    } else if (!check.query) {
      results.push({ ...check, status: "not_run", detail: check.problem ?? "not run" });
    } else {
      try {
        const { pass, detail } = judge(check.assertion, await select(check.query));
        results.push({ ...check, status: pass ? "pass" : "fail", detail });
      } catch (e) {
        results.push({ ...check, status: "error", detail: (e instanceof Error ? e.message : String(e)).split("\n")[0] });
      }
    }
  }
  return results;
}

function labelOf(a: Assertion): string {
  switch (a.type) {
    case "row_count":
      return `row_count = ${a.equals}`;
    case "no_nulls":
      return `no_nulls ${a.columns.join(", ")}`;
    case "unique":
      return `unique ${a.columns.join(", ")}`;
    case "aggregate":
      return `${a.fn}(${a.column}) = ${a.equals}${a.tolerance ? ` ± ${a.tolerance}` : ""}`;
    case "rows_equal":
      return `rows_equal on ${a.key.join(", ")} (${a.rows.length} row${a.rows.length === 1 ? "" : "s"})`;
    case "sql":
      return `sql = ${show(a.equals)}`;
  }
}

const AGGREGATES: Record<string, (column: string) => string> = {
  sum: (c) => `SUM(${c})`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
  avg: (c) => `AVG(${c})`,
  count_distinct: (c) => `COUNT(DISTINCT ${c})`,
};

/** The SELECT that checks `a` on a checkpoint's result `q`. Column names are always quoted, so an assertion can't add SQL. */
function checkQuery(a: Assertion, q: Fragment): Fragment {
  const from = concat([" FROM (", q, ') AS "_C"']);
  const columns = (list: string[]) => list.map(quoteIdentifier).join(", ");
  switch (a.type) {
    case "row_count":
      return concat(['SELECT COUNT(*) AS "VALUE"', from]);
    case "no_nulls":
      return concat(['SELECT COUNT(*) AS "VALUE"', from, ` WHERE ${a.columns.map((c) => `${quoteIdentifier(c)} IS NULL`).join(" OR ")}`]);
    case "unique":
      return concat(['SELECT COUNT(*) AS "VALUE" FROM (SELECT 1 AS "ONE"', from, ` GROUP BY ${columns(a.columns)} HAVING COUNT(*) > 1) AS "_D"`]);
    case "aggregate":
      return concat([`SELECT ${AGGREGATES[a.fn](quoteIdentifier(a.column))} AS "VALUE"`, from]);
    case "rows_equal":
      return concat(["SELECT *", from, ` LIMIT ${MAX_COMPARED_ROWS + 1}`]);
    case "sql":
      return userQuery(a.query, q);
  }
}

const PLACEHOLDER = "{{checkpoint}}";

/**
 * An `sql` assertion's own SELECT, with each `{{checkpoint}}` replaced by the
 * checkpoint's result as a subquery. Only a placeholder in the SQL itself is
 * replaced, not one in a string; comments are dropped, as in compiled steps.
 */
function userQuery(text: string, q: Fragment): Fragment {
  const tokens = tokenize(text);
  if (tokens.some((t) => t.text === "?")) throw new SimulationStop("its query has ? placeholders");
  const parts: (string | Fragment)[] = [];
  let used = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens.slice(i, i + 5).map((t) => t.text).join("").toLowerCase() === PLACEHOLDER) {
      parts.push(concat(["(", q, ")"]));
      used = true;
      i += 4;
    } else {
      parts.push(tokens[i].text);
    }
  }
  if (!used) throw new SimulationStop(`its query doesn't read ${PLACEHOLDER}`);
  const query = concat(parts);
  try {
    assertSelectOnly(query.sql);
  } catch (e) {
    if (e instanceof NotSelectError) throw new SimulationStop(`its query isn't a single SELECT: ${e.message}`);
    throw e;
  }
  return query;
}

/** Whether a check's result passes, and what came back, in words. */
function judge(a: Assertion, rows: Row[]): { pass: boolean; detail: string } {
  const value = rows[0]?.VALUE;
  const count = asNumber(value) ?? NaN;
  if ((a.type === "row_count" || a.type === "no_nulls" || a.type === "unique") && !Number.isInteger(count)) {
    return { pass: false, detail: `the database gave ${show(normal(value))}, not a count` };
  }
  switch (a.type) {
    case "row_count":
      return { pass: count === a.equals, detail: `${rowsOf(count)}${count === a.equals ? "" : `, ${a.equals} expected`}` };
    case "no_nulls":
      return { pass: count === 0, detail: count ? `${rowsOf(count)} with no ${a.columns.join(" or no ")}` : "no empty values" };
    case "unique":
      return { pass: count === 0, detail: count ? `${count} value${count === 1 ? "" : "s"} of ${a.columns.join(", ")} appear more than once` : "every value appears once" };
    case "aggregate": {
      const got = asNumber(value);
      if (got === undefined) return { pass: false, detail: `got ${show(normal(value))}, not a number` };
      return { pass: Math.abs(got - a.equals) <= a.tolerance, detail: `got ${got}` };
    }
    case "rows_equal":
      return compareRows(a.key, a.rows, rows);
    case "sql": {
      const columns = rows.length ? Object.keys(rows[0]) : [];
      if (rows.length !== 1 || columns.length !== 1) return { pass: false, detail: `returned ${rowsOf(rows.length)} and ${columns.length} column${columns.length === 1 ? "" : "s"}; one of each expected` };
      const got = rows[0][columns[0]];
      return { pass: sameValue(a.equals, got), detail: `got ${show(normal(got))}` };
    }
  }
}

const rowsOf = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

/**
 * The checkpoint's rows against the expected ones: matched on `key`, then
 * compared on every other column an expected row names (other columns of the
 * result are left alone).
 */
export function compareRows(key: string[], expected: Record<string, Cell>[], actual: Row[]): { pass: boolean; detail: string } {
  if (actual.length > MAX_COMPARED_ROWS) return { pass: false, detail: `more than ${MAX_COMPARED_ROWS.toLocaleString("en-US")} rows came back, too many to compare` };
  const withoutKey = expected.findIndex((row) => key.some((k) => !(k in row)));
  if (withoutKey >= 0) return { pass: false, detail: `expected row ${withoutKey + 1} has no ${key.find((k) => !(k in expected[withoutKey]))}` };
  const keyOf = (row: Record<string, Cell>) => JSON.stringify(key.map((k) => row[k]));
  const twiceExpected = expected.findIndex((row, i) => expected.findIndex((other) => keyOf(other) === keyOf(row)) !== i);
  if (twiceExpected >= 0) return { pass: false, detail: `expected row ${twiceExpected + 1} has the same ${key.join(", ")} as an earlier one` };
  const named = [...new Set(expected.flatMap((row) => Object.keys(row)))];
  const absent = actual.length ? named.filter((c) => !(c in actual[0])) : [];
  if (absent.length) return { pass: false, detail: `the result has no column ${absent.join(", ")}` };

  const keyText = (row: Row) => key.map((k) => `${k} ${show(normal(row[k]))}`).join(", ");
  const matched = new Set<number>();
  const missing: string[] = [];
  const twice: string[] = [];
  const different: string[] = [];
  for (const row of expected) {
    const hits = actual.flatMap((got, i) => (key.every((k) => sameValue(row[k], got[k])) ? [i] : []));
    hits.forEach((i) => matched.add(i));
    if (!hits.length) missing.push(keyText(row));
    else if (hits.length > 1) twice.push(`${keyText(row)} (${hits.length} times)`);
    else {
      const got = actual[hits[0]];
      const off = Object.keys(row).filter((c) => !key.includes(c) && !sameValue(row[c], got[c]));
      if (off.length) different.push(`${keyText(row)}: ${off.map((c) => `${c} ${show(normal(got[c]))}, ${show(row[c])} expected`).join("; ")}`);
    }
  }
  const extra = actual.flatMap((row, i) => (matched.has(i) ? [] : [keyText(row)]));
  const parts = [
    list("missing", missing),
    list("more than once", twice),
    list("different", different),
    list("not expected", extra),
  ].filter(Boolean);
  return parts.length ? { pass: false, detail: parts.join(". ") } : { pass: true, detail: `the ${rowsOf(expected.length)} expected` };
}

/** "missing: A, B, C and 2 more" */
function list(title: string, items: string[]): string {
  if (!items.length) return "";
  const shown = items.slice(0, 3).join("; ");
  return `${items.length} ${title}: ${shown}${items.length > 3 ? ` and ${items.length - 3} more` : ""}`;
}

/**
 * A value as the database driver gives it, made comparable: big integers as
 * numbers, binary as hex. hdb gives dates and timestamps as text; a Date comes
 * only from other drivers (PostgreSQL in tests), which read the database's
 * value as local time, so its local fields are that value.
 */
function normal(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) {
    const two = (n: number) => String(n).padStart(2, "0");
    const date = `${v.getFullYear()}-${two(v.getMonth() + 1)}-${two(v.getDate())}`;
    const time = `${two(v.getHours())}:${two(v.getMinutes())}:${two(v.getSeconds())}${v.getMilliseconds() ? `.${String(v.getMilliseconds()).padStart(3, "0")}` : ""}`;
    return time === "00:00:00" ? date : `${date} ${time}`;
  }
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return v;
}

function asNumber(v: unknown): number | undefined {
  const n = normal(v);
  if (typeof n === "number") return Number.isFinite(n) ? n : undefined;
  if (typeof n === "string" && n.trim() !== "" && Number.isFinite(Number(n))) return Number(n);
  return undefined;
}

/** A timestamp written either way (`T` or a space, with or without zero fractions) compares as the same text. */
const timestampText = (s: string) => (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? s.replace("T", " ").replace(/\.0+$/, "") : s);

/**
 * Whether a value from the result is the one the scenario expects. A number
 * written as a number compares as a number (SAP HANA gives decimals as text);
 * one written in quotes compares as text, so "007" stays "007".
 */
export function sameValue(expected: Cell | undefined, actual: unknown): boolean {
  const got = normal(actual);
  if (expected === null || expected === undefined) return got === null || got === undefined;
  if (got === null || got === undefined) return false;
  if (typeof expected === "number") {
    const n = asNumber(got);
    return n !== undefined && Math.abs(n - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  }
  if (typeof expected === "boolean") return got === expected || got === (expected ? 1 : 0);
  if (typeof got === "string") return timestampText(got) === timestampText(expected);
  return String(got) === expected;
}

function show(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}
