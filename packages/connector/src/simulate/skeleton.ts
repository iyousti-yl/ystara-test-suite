import { FLOW_TYPES, refKey, TABLE_TYPES, type LineageGraph, type Pipeline, type ScenarioColumn, type ScenarioInputs, type ScenarioStepNote } from "@ystara/shared";
import { tableColumns, type FixtureColumn } from "./fixtures.js";
import { SimulationStop } from "./fragment.js";
import { simulatePipeline, stepLogic, type Simulation } from "./simulate.js";
import { columnUsage } from "./usage.js";

/**
 * What a scenario of the pipeline can fill and check, from its definitions
 * alone (nothing is sent): the tables that take rows (every one no compiled
 * transformation flow loads), with all their columns, what the pipeline's
 * logic does with each (`columnUsage`) and why they take rows; the views and
 * tables a check can be on, with their columns when the definition lists
 * them; and what stands in for each step when no rows are given. The builder
 * in the app offers these, and `scenarioSkeleton` writes them as YAML.
 */
export function scenarioInputs(graph: LineageGraph, pipeline: Pipeline): Omit<ScenarioInputs, "scanId" | "drafting"> {
  const simulation = simulatePipeline(graph, pipeline, { withoutFixture: "empty" });
  const usage = columnUsage(graph, pipeline);
  const annotated = (c: FixtureColumn): ScenarioColumn => ({
    ...c,
    ...(usage.used.has(c.name) ? { used: true } : {}),
    ...(usage.joined.has(c.name) ? { joined: true } : {}),
    ...(usage.keeps.has(c.name) ? { keeps: usage.keeps.get(c.name) } : {}),
    ...(usage.range.has(c.name) ? { range: usage.range.get(c.name) } : {}),
  });
  const nodes = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const columnsOf = (key: string) => {
    const node = nodes.get(key)!;
    try {
      return tableColumns(node.definition, node.technicalName).columns;
    } catch (e) {
      if (e instanceof SimulationStop) return null;
      throw e;
    }
  };
  return {
    tables: simulation.steps.filter((s) => s.fixture).map((s) => ({ ...s.ref, why: s.fixture!.why ?? "", columns: s.fixture!.columns.map(annotated) })),
    checkpoints: simulation.steps
      .filter((s) => s.query && !FLOW_TYPES.has(s.ref.type))
      .map((s) => ({ ...s.ref, columns: s.fixture?.columns ?? columnsOf(refKey(s.ref)) })),
    steps: stepNotes(simulation),
  };
}

/**
 * The pipeline's logic, upstream first, for working out what each step should
 * return (`npm run scenario:new -- --logic`, and the brief Claude drafts a
 * scenario from): each step with what stands in for it, then the columns of
 * a table (type, and whether it is a key) or the SQL or CSN query of a view
 * or flow, as its definition writes it.
 */
export function pipelineLogic(graph: LineageGraph, pipeline: Pipeline): string {
  const nodes = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const simulation = simulatePipeline(graph, pipeline, { withoutFixture: "empty" });
  const lines: string[] = [];
  for (const step of simulation.steps) {
    const node = nodes.get(refKey(step.ref))!;
    lines.push("", `== ${refKey(step.ref)} (${step.ref.type.replace(/_/g, " ")}): ${step.problem ? `STOPS: ${step.problem}` : step.note}`);
    if (TABLE_TYPES.has(node.type)) {
      try {
        for (const c of tableColumns(node.definition, node.technicalName).columns) lines.push(`   ${c.name}  ${c.type}${c.key ? "  key" : ""}`);
      } catch (e) {
        if (!(e instanceof SimulationStop)) throw e;
        lines.push(`   (${e.message})`);
      }
      continue;
    }
    const logic = stepLogic(node);
    if (logic) lines.push(logic.language === "csn" ? `CSN query:\n${logic.text}` : logic.text.trim());
  }
  return lines.join("\n");
}

/** What stood in for each step, as a run stores it. */
export function stepNotes(simulation: Simulation): ScenarioStepNote[] {
  return simulation.steps.map((s) => ({ ...s.ref, note: s.note, ...(s.problem ? { problem: s.problem } : {}) }));
}

/**
 * The start of a scenario for a pipeline, as YAML for a person to fill in
 * (`npm run scenario:new`): every table that takes rows, with one row of all
 * its columns set to null and each column's type beside it, and a first check
 * at the output. Comments say why each table takes rows, which steps can be
 * checked and which can't be simulated. It parses as a scenario and compiles
 * as it is, so the person only changes values.
 *
 * Throws SimulationStop when no table of the pipeline takes rows (every one
 * is loaded by a step that can't be compiled).
 */
export function scenarioSkeleton(graph: LineageGraph, pipeline: Pipeline, opts: { from?: string; file?: string } = {}): string {
  const { tables, checkpoints, steps } = scenarioInputs(graph, pipeline);
  if (!tables.length) throw new SimulationStop("no table of the pipeline can take rows: each one is loaded by a step that can't be compiled");
  const stopped = steps.filter((s) => s.problem);
  const output = refKey(pipeline.output);

  const lines = [
    `# A scenario for ${output}, written by npm run scenario:new${opts.from ? ` from the scan ${opts.from}` : ""}.`,
    "# 1. Under fixtures, give each table the rows of your test: replace the nulls, and copy a row for more.",
    "#    A column left out or null is empty, and a table with no rows is empty.",
    "# 2. Under expect, say what you expect at the output, and at any step listed below.",
    `# 3. Check it with npm run scenario:run -- --file ${opts.file ?? "<this file>"} --compile-only, then run it without --compile-only.`,
    "# The guide: docs/writing-scenarios.md",
    "#",
    "# Steps you can check:",
    ...checkpoints.map((s) => `#   ${refKey(s)}`),
  ];
  if (stopped.length) {
    lines.push("# Steps that can't be simulated, nor the steps that read them:");
    for (const s of stopped) lines.push(`#   ${refKey(s)}: ${s.problem}`);
  }
  lines.push(`name: ${scalar(pipeline.output.technicalName)}`, "kind: golden", `pipeline: ${scalar(output)}`, "fixtures:");
  for (const table of tables) {
    lines.push(`  # ${table.technicalName}: ${table.why}`, `  - table: ${scalar(refKey(table))}`, "    rows:");
    const keys = table.columns.map((c) => `${scalar(c.name)}: null`);
    const width = Math.max(...keys.map((k) => k.length));
    table.columns.forEach((c, i) => lines.push(`${i ? "        " : "      - "}${keys[i].padEnd(width)}  # ${c.type}`));
  }
  lines.push(
    "expect:",
    `  - checkpoint: ${scalar(output)}`,
    "    assertions:",
    "      # How many rows your rows should give at the output: work it out, then replace the 1.",
    "      - { type: row_count, equals: 1 }",
  );
  return `${lines.join("\n")}\n`;
}

/** A name as a YAML scalar: bare when it can't be read as anything but text, otherwise in double quotes. */
function scalar(text: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(text) && !/^(null|true|false|yes|no|on|off|y|n)$/i.test(text) ? text : JSON.stringify(text);
}
