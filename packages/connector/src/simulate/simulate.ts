import { FLOW_TYPES, refKey, TABLE_TYPES, type DspObject, type DspObjectRef, type LineageGraph, type Pipeline } from "@ystara/shared";
import { compileCsnQuery } from "./csn.js";
import { fixtureQuery, sampleRows, tableColumns, type Cell, type FixtureColumn } from "./fixtures.js";
import { SimulationStop, type Fragment } from "./fragment.js";
import { assertReadsOnlyDummy, inlineReferences } from "./sql-text.js";

/**
 * A simulation of a pipeline (phase 3): one SELECT per step that reads no
 * tenant object, only fixtures inlined from DUMMY, so the logic of every
 * step can be run through a read-only database user, which sees no table
 * and no view but the exposed ones.
 *
 *  - A table nothing in the pipeline writes gets a fixture: the rows given
 *    for it, or made-up rows (`sampleRows`).
 *  - A table loaded by a transformation flow is that flow's SELECT, as at a
 *    full load: when the flow reads its own target (a delta check), that
 *    target starts empty.
 *  - A table loaded by a data flow or replication flow, which can't be
 *    expressed in SQL, gets a fixture too: snapshots cover those flows.
 *    One loaded by a transformation flow that doesn't compile gets one only
 *    when rows are given for it, so made-up rows never stand in for logic.
 *  - SQL views and SQL steps of transformation flows are compiled from their
 *    SQL text (`inlineReferences`), graphical views from their CSN query
 *    (`compileCsnQuery`).
 *
 * A step that can't be compiled gets a `problem`, and so does every step
 * that reads it: nothing ever falls back to reading the real object.
 */

export interface SimulatedStep {
  ref: DspObjectRef;
  /** What stands in for the step, in words: "3 made-up rows", "compiled from its SQL", ... */
  note: string;
  /** Why the step can't be simulated, when it can't. */
  problem?: string;
  /** The step's SELECT over the fixtures: run alone, it checks this step and everything upstream. */
  query?: Fragment;
  /** Steps whose query this one inlines (fixtures included). */
  reads: DspObjectRef[];
  /** On a table a fixture stands in for (rows given, made up or none): its columns, and why a fixture stands in when no rows are given. */
  fixture?: { columns: FixtureColumn[]; why?: string };
}

export interface Simulation {
  steps: SimulatedStep[];
  /** The output's SELECT, when every step it needs compiled. */
  output?: Fragment;
  /**
   * Other SQL text compiled as if it were `step`'s own, with the same stand-ins
   * (e.g. the SQL a view was deployed as, to compare with what its CSN
   * compiled to). Throws SimulationStop like a step would.
   */
  inline(step: DspObjectRef, sql: string): Fragment;
}

export interface SimulationOptions {
  /**
   * Fixture rows by table, keyed SPACE.NAME or NAME. Rows given for a table
   * stand in for it, also in place of a transformation flow that loads it.
   */
  fixtures?: ReadonlyMap<string, Record<string, Cell>[]>;
  /** What a table without given rows holds, when no transformation flow loads it: made-up rows (default) or none (a scenario). */
  withoutFixture?: "sample" | "empty";
  /** How many made-up rows each table without a fixture gets (default 3). */
  sampleRows?: number;
}

type Entity = Record<string, unknown>;

/**
 * The most values SAP HANA binds to one statement. Each step's SQL is pasted
 * wherever a later step reads it (the read-only guard takes no WITH), so a
 * pipeline that reads the same steps many times can go over it: such a step
 * stops before anything is sent, and the steps before it still run.
 */
export const MAX_BOUND_VALUES = 32_767;

/**
 * The checks every query passes before it can be sent, whatever built it:
 * it reads nothing but subqueries and DUMMY, and SAP HANA takes its number of
 * bound values. Throws SimulationStop.
 */
export function assertSendable(query: Fragment): void {
  assertReadsOnlyDummy(query.sql);
  if (query.params.length <= MAX_BOUND_VALUES) return;
  const n = (v: number) => v.toLocaleString("en-US");
  throw new SimulationStop(
    `its query needs ${n(query.params.length)} values, more than the ${n(MAX_BOUND_VALUES)} SAP HANA takes in one statement, because each step it reads is repeated wherever it is read`,
  );
}

export function simulatePipeline(graph: LineageGraph, pipeline: Pipeline, opts: SimulationOptions = {}): Simulation {
  const nodes = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const inPipeline = new Set(pipeline.steps.map(refKey));
  const excluded = new Set(pipeline.excludedWriters.map((w) => `${refKey(w.writer)}>${refKey(w.table)}`));
  const writersOf = (table: string) =>
    graph.edges
      .filter((e) => e.kind === "writes_to" && refKey(e.to) === table && inPipeline.has(refKey(e.from)) && !excluded.has(`${refKey(e.from)}>${table}`))
      .map((e) => nodes.get(refKey(e.from))!);

  const built = new Map<string, SimulatedStep>();
  const building = new Set<string>();

  /** The key of a name as `reader`'s definition writes it: NAME (its own space), SPACE.NAME, or SPACE and NAME. */
  const keyFor = (reader: DspObject, parts: string[]) => (parts.length === 2 ? parts.join(".") : nodes.has(parts[0]) ? parts[0] : `${reader.space}.${parts[0]}`);

  const build = (key: string): SimulatedStep => {
    const done = built.get(key);
    if (done) return done;
    const node = nodes.get(key)!;
    const step: SimulatedStep = { ref: { space: node.space, technicalName: node.technicalName, type: node.type }, note: "", reads: [] };
    building.add(key);
    try {
      const result = compile(node, step);
      // The last check before anything can be sent, whatever compiled the step.
      if (result.query) assertSendable(result.query);
      // standIn may have added a sentence while compiling (an own target that starts empty).
      step.note = `${result.note}${step.note}`;
      step.query = result.query;
    } catch (e) {
      if (!(e instanceof SimulationStop)) throw e;
      step.problem = e.message;
      step.query = undefined;
    } finally {
      building.delete(key);
    }
    built.set(key, step);
    return step;
  };

  /** What replaces `parts` when `reader` reads it. */
  const standIn = (reader: DspObject, step: SimulatedStep, parts: string[]): Fragment => {
    const key = keyFor(reader, parts);
    const node = nodes.get(key);
    if (!node) throw new SimulationStop(`it reads ${parts.join(".")}, which isn't in the scan, so nothing can stand in for it`);
    if (!inPipeline.has(key)) throw new SimulationStop(`it reads ${node.technicalName}, which isn't part of the pipeline`);
    if (!step.reads.some((r) => refKey(r) === key)) step.reads.push({ space: node.space, technicalName: node.technicalName, type: node.type });
    // A flow that reads the table it loads (a delta check): at a full load, that table is empty.
    if (TABLE_TYPES.has(node.type) && writersOf(key).some((w) => w === reader)) {
      // Said once, however often the flow's SQL reads its target.
      const empty = `; its own target ${node.technicalName} starts empty (full load)`;
      if (!step.note.includes(empty)) step.note += empty;
      return fixtureQuery(node.technicalName, tableColumns(node.definition, node.technicalName).columns, []);
    }
    if (building.has(key)) throw new SimulationStop(`it reads ${node.technicalName}, which reads it back (a loop)`);
    const upstream = build(key);
    if (!upstream.query) throw new SimulationStop(`it reads ${node.technicalName}, which can't be simulated`);
    return upstream.query;
  };

  /** SQL text as `node` has it, with what it reads replaced by stand-ins; a name that is no object of the scan is left to inlineReferences. */
  const inlineFor = (node: DspObject, step: SimulatedStep, sql: string) =>
    inlineReferences(
      sql,
      (parts) => (nodes.has(keyFor(node, parts)) ? standIn(node, step, parts) : undefined),
      (parts) => nodes.has(keyFor(node, parts)),
    );

  const compile = (node: DspObject, step: SimulatedStep): { note: string; query?: Fragment } => {
    if (TABLE_TYPES.has(node.type)) return table(node, step);
    if (node.type === "sql_view" || node.type === "graphical_view") {
      const entity = entityOf(node);
      if (entity.params) throw new SimulationStop("it has input parameters, which the simulation can't fill yet");
      const sql = entity["@DataWarehouse.sqlEditor.query"];
      if (typeof sql === "string") return { note: "compiled from its SQL", query: inlineFor(node, step, sql) };
      const query = entity.query ?? (entity.projection ? { SELECT: entity.projection } : undefined);
      if (!query) throw new SimulationStop("its definition has neither SQL nor a CSN query");
      return { note: "compiled from its CSN query", query: compileCsnQuery(query, (parts) => standIn(node, step, parts)) };
    }
    if (node.type === "transformation_flow") return { note: "compiled from its SQL step", query: inlineFor(node, step, flowSql(node)) };
    if (FLOW_TYPES.has(node.type)) return { note: `not simulated: a ${node.type.replace(/_/g, " ")} can't be expressed in SQL, so the table it loads gets a fixture` };
    throw new SimulationStop(`a ${node.type.replace(/_/g, " ")} can't be simulated yet`);
  };

  const table = (node: DspObject, step: SimulatedStep): { note: string; query: Fragment } => {
    const writers = writersOf(refKey(node));
    const flow = writers.length === 1 && writers[0].type === "transformation_flow" ? writers[0] : undefined;
    const given = opts.fixtures?.get(refKey(node)) ?? opts.fixtures?.get(node.technicalName);
    // Read only when a fixture stands in: a table its flow fills needs no columns of its own.
    const fixture = () => {
      const { columns, unknownTypes } = tableColumns(node.definition, node.technicalName);
      return { columns, unknown: unknownTypes.length ? `; columns of a type the simulation doesn't know are text: ${unknownTypes.join(", ")}` : "" };
    };
    const rowsOf = (n: number, kind: string) => `${n} ${kind} row${n === 1 ? "" : "s"}`;
    if (given) {
      const { columns, unknown } = fixture();
      step.fixture = { columns };
      // Given rows win, also over the flow that loads the table, so a scenario can start in the middle of a pipeline.
      const instead = flow ? `, in place of ${flow.technicalName}, which loads it` : "";
      return { note: `fixture with ${rowsOf(given.length, "given")}${instead}${unknown}`, query: fixtureQuery(node.technicalName, columns, given) };
    }
    let why = "nothing in the pipeline loads it";
    if (flow) {
      const loaded = build(refKey(flow));
      if (loaded.query) {
        step.reads.push(loaded.ref);
        return { note: `the SELECT of ${loaded.ref.technicalName} (full load)`, query: loaded.query };
      }
      // Made-up or no rows would pass off the flow's logic as tested: only rows given for the table stand in for it.
      throw new SimulationStop(`${loaded.ref.technicalName}, which loads it, can't be compiled; give the table a fixture to test the steps after it`);
    } else if (writers.length === 1) {
      why = `${writers[0].technicalName} loads it, and a ${writers[0].type.replace(/_/g, " ")} can't be expressed in SQL`;
    } else if (writers.length > 1) {
      why = `${writers.length} flows load it`;
    }
    const { columns, unknown } = fixture();
    step.fixture = { columns, why };
    if (opts.withoutFixture === "empty") return { note: `empty, because no rows are given for it (${why})${unknown}`, query: fixtureQuery(node.technicalName, columns, []) };
    const rows = sampleRows(columns, opts.sampleRows ?? 3);
    return { note: `fixture with ${rowsOf(rows.length, "made-up")}, because ${why}${unknown}`, query: fixtureQuery(node.technicalName, columns, rows) };
  };

  const steps = pipeline.steps.map((s) => build(refKey(s)));
  const inline = (ref: DspObjectRef, sql: string) => {
    const node = nodes.get(refKey(ref));
    if (!node) throw new SimulationStop(`${refKey(ref)} isn't in the scan`);
    const query = inlineFor(node, { ref, note: "", reads: [] }, sql);
    assertSendable(query);
    return query;
  };
  return { steps, output: built.get(refKey(pipeline.output))?.query, inline };
}

/**
 * A step's logic as its definition holds it: the SQL text of a SQL view or of
 * a transformation flow's SQL step, the CSN query of a graphical view.
 * Undefined for tables, other flows and a definition the simulation can't read.
 */
export function stepSource(node: DspObject): { sql: string } | { csn: unknown } | undefined {
  try {
    if (node.type === "transformation_flow") return { sql: flowSql(node) };
    if (node.type !== "sql_view" && node.type !== "graphical_view") return undefined;
    const entity = entityOf(node);
    const sql = entity["@DataWarehouse.sqlEditor.query"];
    if (typeof sql === "string") return { sql };
    const query = entity.query ?? (entity.projection ? { SELECT: entity.projection } : undefined);
    return query ? { csn: query } : undefined;
  } catch (e) {
    if (e instanceof SimulationStop) return undefined;
    throw e;
  }
}

/**
 * A step's logic as text, for a person (or Claude) working out what it should
 * return: the SQL as written, a CSN query as indented JSON.
 */
export function stepLogic(node: DspObject): { language: "sql" | "csn"; text: string } | undefined {
  const source = stepSource(node);
  if (!source) return undefined;
  return "sql" in source ? { language: "sql", text: source.sql } : { language: "csn", text: compactJson(source.csn) };
}

/** JSON indented by level, with each part that fits in 100 characters on one line, so a CSN query reads like a query. */
function compactJson(value: unknown, indent = ""): string {
  const flat = JSON.stringify(value);
  if (flat === undefined || flat.length + indent.length <= 100 || value === null || typeof value !== "object") return flat ?? "null";
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compactJson(v, inner)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`);
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

/** The object's own CSN entity: `definitions.<name>`. */
function entityOf(node: DspObject): Entity {
  const entity = (node.definition as { definitions?: Record<string, Entity> } | undefined)?.definitions?.[node.technicalName];
  if (!entity) throw new SimulationStop("its definition has no entry under its own name");
  return entity;
}

/**
 * The SQL of a transformation flow's one SQL step: `contents.processes.<step>.metadata.config.definition`,
 * either the SQL text itself or a CSN entity that holds it under `@DataWarehouse.sqlEditor.query`.
 */
function flowSql(node: DspObject): string {
  const flow = (node.definition as { transformationflows?: Record<string, { contents?: { processes?: Record<string, unknown> } }> } | undefined)?.transformationflows?.[
    node.technicalName
  ];
  const processes = Object.values(flow?.contents?.processes ?? {}) as { component?: string; metadata?: { config?: { definition?: unknown } } }[];
  const sqlOf = (definition: unknown) =>
    typeof definition === "string" ? definition : (definition as Entity | undefined)?.["@DataWarehouse.sqlEditor.query"];
  const sql = processes.map((p) => sqlOf(p.metadata?.config?.definition)).filter((d): d is string => typeof d === "string");
  if (sql.length === 1) return sql[0];
  if (sql.length > 1) throw new SimulationStop("it has several SQL steps, which the simulation can't chain yet");
  throw new SimulationStop("it has no SQL step (a graphical transformation can't be compiled yet)");
}
