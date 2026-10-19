import { FLOW_TYPES, refKey, TABLE_TYPES, type DspObject, type DspObjectRef, type LineageGraph, type Pipeline } from "@ystara/shared";
import { compileCsnQuery } from "./csn.js";
import { fixtureQuery, sampleRows, tableColumns, type Cell } from "./fixtures.js";
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
  /** Fixture rows by table, keyed SPACE.NAME or NAME. A table left out gets made-up rows. */
  fixtures?: ReadonlyMap<string, Record<string, Cell>[]>;
  /** How many made-up rows each table without a fixture gets (default 3). */
  sampleRows?: number;
}

type Entity = Record<string, unknown>;

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
      if (result.query) assertReadsOnlyDummy(result.query.sql);
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
    step.reads.push({ space: node.space, technicalName: node.technicalName, type: node.type });
    // A flow that reads the table it loads (a delta check): at a full load, that table is empty.
    if (TABLE_TYPES.has(node.type) && writersOf(key).some((w) => w === reader)) {
      step.note += `; its own target ${node.technicalName} starts empty (full load)`;
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
    const given = opts.fixtures?.get(refKey(node)) ?? opts.fixtures?.get(node.technicalName);
    let why = "nothing in the pipeline loads it";
    if (writers.length === 1 && writers[0].type === "transformation_flow") {
      const flow = build(refKey(writers[0]));
      if (flow.query) {
        step.reads.push(flow.ref);
        return { note: `the SELECT of ${flow.ref.technicalName} (full load)`, query: flow.query };
      }
      // Made-up rows would pass off the flow's logic as tested: only rows given for the table stand in for it.
      if (!given) throw new SimulationStop(`${flow.ref.technicalName}, which loads it, can't be compiled; give the table a fixture to test the steps after it`);
      why = `${flow.ref.technicalName}, which loads it, can't be compiled`;
    } else if (writers.length === 1) {
      why = `${writers[0].technicalName} loads it, and a ${writers[0].type.replace(/_/g, " ")} can't be expressed in SQL`;
    } else if (writers.length > 1) {
      why = `${writers.length} flows load it`;
    }
    const { columns, unknownTypes } = tableColumns(node.definition, node.technicalName);
    const rows = given ?? sampleRows(columns, opts.sampleRows ?? 3);
    const unknown = unknownTypes.length ? `; columns of a type the simulation doesn't know are text: ${unknownTypes.join(", ")}` : "";
    return { note: `fixture with ${rows.length} ${given ? "given" : "made-up"} row${rows.length === 1 ? "" : "s"}, because ${why}${unknown}`, query: fixtureQuery(node.technicalName, columns, rows) };
  };

  const steps = pipeline.steps.map((s) => build(refKey(s)));
  const inline = (ref: DspObjectRef, sql: string) => {
    const node = nodes.get(refKey(ref));
    if (!node) throw new SimulationStop(`${refKey(ref)} isn't in the scan`);
    const query = inlineFor(node, { ref, note: "", reads: [] }, sql);
    assertReadsOnlyDummy(query.sql);
    return query;
  };
  return { steps, output: built.get(refKey(pipeline.output))?.query, inline };
}

/** The object's own CSN entity: `definitions.<name>`. */
function entityOf(node: DspObject): Entity {
  const entity = (node.definition as { definitions?: Record<string, Entity> } | undefined)?.definitions?.[node.technicalName];
  if (!entity) throw new SimulationStop("its definition has no entry under its own name");
  return entity;
}

/** The SQL of a transformation flow's one SQL step (`contents.processes.<step>.metadata.config.definition`). */
function flowSql(node: DspObject): string {
  const flow = (node.definition as { transformationflows?: Record<string, { contents?: { processes?: Record<string, unknown> } }> } | undefined)?.transformationflows?.[
    node.technicalName
  ];
  const processes = Object.values(flow?.contents?.processes ?? {}) as { component?: string; metadata?: { config?: { definition?: unknown } } }[];
  const sql = processes.map((p) => p.metadata?.config?.definition).filter((d): d is string => typeof d === "string");
  if (sql.length === 1) return sql[0];
  if (sql.length > 1) throw new SimulationStop("it has several SQL steps, which the simulation can't chain yet");
  throw new SimulationStop("it has no SQL step (a graphical transformation can't be compiled yet)");
}
