/**
 * Local discovery scan (read-only).
 *
 * Lists and reads every object in one or more spaces with the Datasphere CLI,
 * builds the lineage graph, and optionally the pipeline behind one output
 * object. Nothing in the tenant is created, changed or deleted: the connector
 * only allows `list` and `read` commands.
 *
 * Usage (with DSP_HOST in .env.local, after `datasphere login`, or with a
 * technical OAuth client in DSP_CLIENT_ID, DSP_CLIENT_SECRET and DSP_TOKEN_URL):
 *   npm run scan -- --space HR
 *   npm run scan -- --space HR --space SHARED --output V_HEADCOUNT_OUT
 *   npm run scan -- --from tools/scan/output/<run> --output V_HEADCOUNT_OUT   (replay a saved scan, no tenant needed)
 *   npm run scan -- --from <run> --output V_HEADCOUNT_OUT --exclude-writer DF_OTHER_LOAD --exclude-writer "TF_ARCHIVE_*"
 *
 * When a table in the pipeline has several writers, only the one that belongs
 * to the pipeline should be followed. Name the others with --exclude-writer
 * (repeatable; wildcards * and ?; NAME or SPACE.NAME) or in a git-ignored
 * tools/scan/scan.local.json (another file with --config):
 *   { "excludeWriters": ["DF_OTHER_LOAD"], "pipelines": { "V_HEADCOUNT_OUT": { "excludeWriters": ["TF_*"] } } }
 * The top-level list applies to every pipeline, the `pipelines` lists to that
 * output only. Without exclusions, every writer is followed and the table is
 * reported as ambiguous.
 *
 * Output in tools/scan/output/<timestamp>/ (git-ignored):
 *   raw.json        every definition as the CLI returned it (metadata only, no table rows)
 *   graph.json      nodes (without definitions), edges and warnings
 *   lineage.md      Mermaid diagram (the pipeline if --output is given, otherwise the whole space)
 *   pipeline.json   steps, entry points, excluded and ambiguous writers, cycles (with --output)
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatasphereCli, buildPipeline, graphFromRaw, readSpaces, toMermaid, type RawObject } from "@ystara/connector";
import type { LineageGraph, Pipeline } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const { values } = parseArgs({
  options: {
    space: { type: "string", multiple: true },
    output: { type: "string" },
    from: { type: "string" },
    concurrency: { type: "string" },
    "exclude-writer": { type: "string", multiple: true },
    config: { type: "string" },
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
  // DSP_SPACE holds one or more space IDs separated by commas, as for the technical client spike.
  spaces = values.space ?? (process.env.DSP_SPACE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!host || spaces.length === 0) {
    console.error("Need DSP_HOST in .env.local and at least one --space (or DSP_SPACE, space IDs separated by commas).");
    process.exit(1);
  }
  // A technical OAuth client in .env.local logs in with nobody present, in a temporary CLI folder; otherwise your own `datasphere login`.
  const { DSP_CLIENT_ID: clientId, DSP_CLIENT_SECRET: clientSecret, DSP_TOKEN_URL: tokenUrl } = process.env;
  const client = clientId && clientSecret && tokenUrl ? { clientId, clientSecret, tokenUrl } : undefined;
  const configDir = client ? await mkdtemp(path.join(tmpdir(), "ystara-scan-")) : undefined;
  const cli = new DatasphereCli({ host, bin: process.env.DSP_CLI_BIN, client, configDir });
  console.log(`Scanning ${spaces.join(", ")} on ${host} (read-only, ${client ? `technical client ${clientId}` : "your datasphere login"})`);
  const started = Date.now();
  try {
    if (client) await cli.initCache();
    ({ raw, warnings } = await readSpaces(cli, spaces, {
      concurrency: Number(values.concurrency ?? 4),
      onProgress: (done, total, current) => process.stderr.write(`\r  read ${done}/${total} ${current.padEnd(60).slice(0, 60)}`),
    }));
  } finally {
    if (configDir) await rm(configDir, { recursive: true, force: true });
  }
  process.stderr.write("\n");
  console.log(`Read ${raw.length} objects in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

const graph = graphFromRaw(raw, spaces, warnings);
let pipeline: Pipeline | undefined;
let excludeWriters: string[] = [];
if (values.output) {
  const [space, name] = values.output.includes(".") ? values.output.split(".", 2) : [spaces[0], values.output];
  const config = await loadConfig(values.config ? path.resolve(values.config) : path.join(root, "tools", "scan", "scan.local.json"), Boolean(values.config));
  const forOutput = config.pipelines?.[`${space}.${name}`] ?? config.pipelines?.[name];
  excludeWriters = [...(config.excludeWriters ?? []), ...(forOutput?.excludeWriters ?? []), ...(values["exclude-writer"] ?? [])];
  pipeline = buildPipeline(graph, { space, technicalName: name }, { excludeWriters });
}

const outDir = path.join(root, "tools", "scan", "output", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "raw.json"), JSON.stringify({ spaces, raw, warnings }, null, 2));
await writeFile(path.join(outDir, "graph.json"), JSON.stringify(summary(graph), null, 2));
await writeFile(path.join(outDir, "lineage.md"), `# Lineage${pipeline ? `: ${pipeline.name}` : ""}\n\n\`\`\`mermaid\n${toMermaid(graph, pipeline)}\n\`\`\`\n`);
if (pipeline) await writeFile(path.join(outDir, "pipeline.json"), JSON.stringify({ ...pipeline, excludeWriterPatterns: excludeWriters }, null, 2));

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
    if (p.excludedWriters.length) {
      console.log(`Other writers (excluded): ${p.excludedWriters.map((x) => `${x.writer.technicalName} -> ${x.table.technicalName}`).join(", ")}`);
    }
    for (const a of p.ambiguousWriters) {
      console.log(`Ambiguous: ${a.table.technicalName} has ${a.writers.length} writers (${a.writers.map((w) => w.technicalName).join(", ")}); all were followed.`);
    }
    if (p.ambiguousWriters.length) console.log("  Exclude the writers that belong to other processes with --exclude-writer or tools/scan/scan.local.json.");
    for (const c of p.cycles) {
      console.log(`Cycle: ${c.map((s) => s.technicalName).join(", ")} depend on each other; their order above is by name.`);
    }
  }
}

interface ScanConfig {
  excludeWriters?: string[];
  pipelines?: Record<string, { excludeWriters?: string[] }>;
}

async function loadConfig(file: string, required: boolean): Promise<ScanConfig> {
  if (!existsSync(file)) {
    if (required) throw new Error(`Config file not found: ${file}`);
    return {};
  }
  const config = JSON.parse(await readFile(file, "utf8")) as ScanConfig;
  const lists = [config.excludeWriters, ...Object.values(config.pipelines ?? {}).map((p) => p.excludeWriters)];
  if (!lists.every((l) => l === undefined || (Array.isArray(l) && l.every((x) => typeof x === "string")))) {
    throw new Error(`${file}: excludeWriters must be a list of names or patterns.`);
  }
  console.log(`Using ${path.relative(root, file)}`);
  return config;
}
