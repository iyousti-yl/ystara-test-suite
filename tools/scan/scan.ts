/**
 * Local discovery scan (read-only).
 *
 * Lists and reads every object in one or more spaces with the Datasphere CLI,
 * builds the lineage graph, and optionally the pipeline behind one output
 * object. Nothing in the tenant is created, changed or deleted: the connector
 * only allows `list` and `read` commands.
 *
 * Usage (after `datasphere login` and with DSP_HOST in .env):
 *   npm run scan -- --space HR
 *   npm run scan -- --space HR --space SHARED --output V_HEADCOUNT_OUT
 *   npm run scan -- --from tools/scan/output/<run> --output V_HEADCOUNT_OUT   (replay a saved scan, no tenant needed)
 *
 * Output in tools/scan/output/<timestamp>/ (git-ignored):
 *   raw.json        every definition as the CLI returned it (metadata only, no table rows)
 *   graph.json      nodes (without definitions), edges and warnings
 *   lineage.md      Mermaid diagram (the pipeline if --output is given, otherwise the whole space)
 *   pipeline.json   steps, entry points and task chains (with --output)
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatasphereCli, buildPipeline, graphFromRaw, readSpaces, toMermaid, type RawObject } from "@ystara/connector";
import type { LineageGraph, Pipeline } from "@ystara/shared";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
await loadDotEnv(path.join(root, ".env"));

const { values } = parseArgs({
  options: {
    space: { type: "string", multiple: true },
    output: { type: "string" },
    from: { type: "string" },
    concurrency: { type: "string" },
  },
});

let raw: RawObject[];
let warnings: string[];
let spaces: string[];

if (values.from) {
  const saved = JSON.parse(await readFile(path.resolve(values.from, "raw.json"), "utf8")) as { spaces: string[]; raw: RawObject[]; warnings: string[] };
  ({ raw, warnings, spaces } = saved);
  console.log(`Replaying ${raw.length} objects from ${values.from}`);
} else {
  const host = process.env.DSP_HOST;
  spaces = values.space ?? (process.env.DSP_SPACE ? [process.env.DSP_SPACE] : []);
  if (!host || spaces.length === 0) {
    console.error("Need DSP_HOST in .env and at least one --space (or DSP_SPACE).");
    process.exit(1);
  }
  const cli = new DatasphereCli({ host, bin: process.env.DSP_CLI_BIN });
  console.log(`Scanning ${spaces.join(", ")} on ${host} (read-only)`);
  const started = Date.now();
  ({ raw, warnings } = await readSpaces(cli, spaces, {
    concurrency: Number(values.concurrency ?? 4),
    onProgress: (done, total, current) => process.stderr.write(`\r  read ${done}/${total} ${current.padEnd(60).slice(0, 60)}`),
  }));
  process.stderr.write("\n");
  console.log(`Read ${raw.length} objects in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

const graph = graphFromRaw(raw, spaces, warnings);
let pipeline: Pipeline | undefined;
if (values.output) {
  const [space, name] = values.output.includes(".") ? values.output.split(".", 2) : [spaces[0], values.output];
  pipeline = buildPipeline(graph, { space, technicalName: name });
}

const outDir = path.join(root, "tools", "scan", "output", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "raw.json"), JSON.stringify({ spaces, raw, warnings }, null, 2));
await writeFile(path.join(outDir, "graph.json"), JSON.stringify(summary(graph), null, 2));
await writeFile(path.join(outDir, "lineage.md"), `# Lineage${pipeline ? `: ${pipeline.name}` : ""}\n\n\`\`\`mermaid\n${toMermaid(graph, pipeline)}\n\`\`\`\n`);
if (pipeline) await writeFile(path.join(outDir, "pipeline.json"), JSON.stringify(pipeline, null, 2));

printSummary(graph, pipeline);
console.log(`\nSaved to ${path.relative(root, outDir)}`);

// ---- helpers ----
function summary(g: LineageGraph) {
  return { ...g, nodes: g.nodes.map(({ definition: _definition, ...rest }) => rest) };
}

function printSummary(g: LineageGraph, p?: Pipeline) {
  const byType = new Map<string, number>();
  for (const n of g.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
  console.log("\nObjects by type:");
  for (const [type, count] of [...byType].sort()) console.log(`  ${type.padEnd(20)} ${count}`);
  console.log(`Edges: ${g.edges.length} (${g.edges.filter((e) => e.kind === "triggers").length} task chain steps)`);
  const isolated = g.nodes.filter((n) => !g.edges.some((e) => e.from.technicalName === n.technicalName || e.to.technicalName === n.technicalName));
  if (isolated.length) console.log(`Objects with no links found: ${isolated.length} (check these if you expected lineage)`);
  if (g.warnings.length) {
    console.log(`Warnings (${g.warnings.length}):`);
    for (const w of g.warnings.slice(0, 20)) console.log(`  - ${w}`);
  }
  if (p) {
    console.log(`\nPipeline for ${p.output.space}.${p.output.technicalName}: ${p.steps.length} steps`);
    p.steps.forEach((s, i) => {
      const mark = p.entryPoints.some((e) => e.technicalName === s.technicalName && e.space === s.space) ? "  <- entry" : "";
      console.log(`  ${String(i + 1).padStart(2)}. ${s.technicalName} (${s.type})${mark}`);
    });
    if (p.orchestrators.length) console.log(`  Run by: ${p.orchestrators.map((o) => o.technicalName).join(", ")}`);
  }
}

async function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
