import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { graphFromRaw, type RawObject } from "@ystara/connector";

/**
 * A scan saved by `npm run scan` (tools/scan/output/<run>/raw.json) and its
 * lineage graph: the newest one, or the folder given. Reading it sends nothing.
 */
export function loadSavedScan(root: string, given?: string) {
  const from = given ? path.resolve(given) : newestScan(root);
  const saved = JSON.parse(readFileSync(path.join(from, "raw.json"), "utf8")) as { spaces: string[]; raw: RawObject[]; warnings: string[] };
  return { from, spaces: saved.spaces, graph: graphFromRaw(saved.raw, saved.spaces, saved.warnings) };
}

/** An object written SPACE.NAME, or NAME in the scan's first space. */
export function objectIn(spaces: string[], name: string): { space: string; technicalName: string } {
  const [space, technicalName] = name.includes(".") ? name.split(".", 2) : [spaces[0], name];
  return { space, technicalName };
}

/** The newest scan folder with a raw.json. */
function newestScan(root: string): string {
  const dir = path.join(root, "tools", "scan", "output");
  const runs = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "raw.json"))).sort() : [];
  if (!runs.length) {
    console.error("No saved scan in tools/scan/output. Run npm run scan -- --space <SPACE> first, or give --from.");
    process.exit(1);
  }
  return path.join(dir, runs.at(-1)!);
}
