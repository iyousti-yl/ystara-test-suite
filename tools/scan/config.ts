import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writer exclusions for pipelines, from tools/scan/scan.local.json (git-ignored)
 * or the file given with --config:
 *   { "excludeWriters": ["DF_OTHER_LOAD"], "pipelines": { "V_HEADCOUNT_OUT": { "excludeWriters": ["TF_*"] } } }
 * The top-level list applies to every pipeline, the `pipelines` lists to that output only.
 */
export interface ScanConfig {
  excludeWriters?: string[];
  pipelines?: Record<string, { excludeWriters?: string[] }>;
}

/** The given file (which must exist), else scan.local.json if there is one. */
export async function loadScanConfig(root: string, given?: string): Promise<ScanConfig> {
  const file = given ? path.resolve(given) : path.join(root, "tools", "scan", "scan.local.json");
  if (!existsSync(file)) {
    if (given) throw new Error(`Config file not found: ${file}`);
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

/** The exclusions for the pipeline of SPACE.NAME: every pipeline's, this output's, then `extra` (--exclude-writer). */
export function excludeWritersFor(config: ScanConfig, space: string, name: string, extra: string[] = []): string[] {
  const forOutput = config.pipelines?.[`${space}.${name}`] ?? config.pipelines?.[name];
  return [...(config.excludeWriters ?? []), ...(forOutput?.excludeWriters ?? []), ...extra];
}
