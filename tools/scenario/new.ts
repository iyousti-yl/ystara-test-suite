/**
 * Starts a scenario (phase 3a): writes the YAML skeleton of a scenario for a
 * pipeline from a saved scan, with every table that takes rows, all its
 * columns set to null and their types beside them, and a first check at the
 * output (scenarioSkeleton in packages/connector/src/simulate). Reading the
 * scan sends nothing to the tenant.
 *
 * Usage:
 *   npm run scenario:new -- --output HR.V_HEADCOUNT_OUT --file tools/scenario/headcount.local.yaml
 *       writes the skeleton; refuses a file that exists, and one whose name
 *       doesn't end in .local.yaml (git ignores those, and a scenario for a
 *       real tenant names its objects)
 *   --logic           print each step's logic as its definition writes it: the
 *                     SQL of SQL views and transformation flows, the CSN query
 *                     of graphical views, the columns of tables. For working
 *                     out what each step should return. Works without --file.
 *   --from <scan folder>, --config, --exclude-writer   as for npm run scenario:run
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPipeline, scenarioSkeleton, simulatePipeline, SimulationStop, stepLogic, tableColumns } from "@ystara/connector";
import { refKey, TABLE_TYPES } from "@ystara/shared";
import { excludeWritersFor, loadScanConfig } from "../scan/config.js";
import { loadSavedScan, objectIn } from "../scan/saved.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    file: { type: "string" },
    logic: { type: "boolean" },
    from: { type: "string" },
    "exclude-writer": { type: "string", multiple: true },
    config: { type: "string" },
  },
});
if (!values.output || (!values.file && !values.logic)) {
  console.error("npm run scenario:new -- --output [SPACE.]OBJECT --file tools/scenario/<name>.local.yaml [--logic] [--from <scan folder>]");
  process.exit(1);
}
const file = values.file && path.resolve(values.file);
if (file && !file.endsWith(".local.yaml")) {
  console.error(`${values.file}: a scenario's file name ends in .local.yaml, which git ignores, because it names the tenant's objects.`);
  process.exit(1);
}
if (file && existsSync(file)) {
  console.error(`${values.file} exists already; give another name, or edit that file.`);
  process.exit(1);
}

const { from, spaces, graph } = loadSavedScan(root, values.from);
const { space, technicalName } = objectIn(spaces, values.output);
if (!graph.nodes.some((n) => n.space === space && n.technicalName === technicalName)) {
  console.error(`${space}.${technicalName} isn't in the scan ${path.relative(root, from)}.`);
  process.exit(1);
}
const config = await loadScanConfig(root, values.config);
const pipeline = buildPipeline(graph, { space, technicalName }, { excludeWriters: excludeWritersFor(config, space, technicalName, values["exclude-writer"]) });

if (values.logic) {
  const nodes = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const simulation = simulatePipeline(graph, pipeline, { withoutFixture: "empty" });
  console.log(`The logic of ${space}.${technicalName}'s ${pipeline.steps.length} steps, upstream first, from ${path.relative(root, from)}:`);
  for (const step of simulation.steps) {
    const node = nodes.get(refKey(step.ref))!;
    console.log(`\n== ${refKey(step.ref)} (${step.ref.type.replace(/_/g, " ")}): ${step.problem ? `STOPS: ${step.problem}` : step.note}`);
    if (TABLE_TYPES.has(node.type)) {
      try {
        for (const c of tableColumns(node.definition, node.technicalName).columns) console.log(`   ${c.name}  ${c.type}`);
      } catch (e) {
        if (!(e instanceof SimulationStop)) throw e;
        console.log(`   (${e.message})`);
      }
      continue;
    }
    const logic = stepLogic(node);
    if (logic) console.log(logic.language === "csn" ? `CSN query:\n${logic.text}` : logic.text.trim());
  }
}

if (file) {
  let yaml: string;
  try {
    yaml = scenarioSkeleton(graph, pipeline, { from: path.relative(root, from), file: path.relative(root, file) });
  } catch (e) {
    if (!(e instanceof SimulationStop)) throw e;
    console.error(`No scenario can start on ${space}.${technicalName}: ${e.message}.`);
    process.exit(1);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, yaml, { encoding: "utf8", flag: "wx" });
  console.log(`\nWrote ${path.relative(root, file)}: fill in its rows and checks, then run npm run scenario:run -- --file ${path.relative(root, file)} --compile-only`);
}
