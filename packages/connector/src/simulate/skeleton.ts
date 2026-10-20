import { FLOW_TYPES, refKey, type LineageGraph, type Pipeline } from "@ystara/shared";
import { SimulationStop } from "./fragment.js";
import { simulatePipeline } from "./simulate.js";

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
  const simulation = simulatePipeline(graph, pipeline, { withoutFixture: "empty" });
  const tables = simulation.steps.filter((s) => s.fixture);
  if (!tables.length) throw new SimulationStop("no table of the pipeline can take rows: each one is loaded by a step that can't be compiled");
  const checkpoints = simulation.steps.filter((s) => s.query && !FLOW_TYPES.has(s.ref.type));
  const stopped = simulation.steps.filter((s) => s.problem);
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
    ...checkpoints.map((s) => `#   ${refKey(s.ref)}`),
  ];
  if (stopped.length) {
    lines.push("# Steps that can't be simulated, nor the steps that read them:");
    for (const s of stopped) lines.push(`#   ${refKey(s.ref)}: ${s.problem}`);
  }
  lines.push(`name: ${scalar(pipeline.output.technicalName)}`, "kind: golden", `pipeline: ${scalar(output)}`, "fixtures:");
  for (const step of tables) {
    lines.push(`  # ${step.ref.technicalName}: ${step.fixture!.why}`, `  - table: ${scalar(refKey(step.ref))}`, "    rows:");
    const keys = step.fixture!.columns.map((c) => `${scalar(c.name)}: null`);
    const width = Math.max(...keys.map((k) => k.length));
    step.fixture!.columns.forEach((c, i) => lines.push(`${i ? "        " : "      - "}${keys[i].padEnd(width)}  # ${c.type}`));
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
