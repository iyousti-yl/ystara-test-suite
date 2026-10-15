import type { DspObject, LineageGraph } from "@ystara/shared";
import { classifyObject, hashDefinition } from "../classify.js";
import { CLI_OBJECT_KINDS, type CliObjectKind } from "../readonly.js";
import type { ObjectSource } from "../types.js";
import { buildGraph } from "./graph.js";

export interface RawObject {
  space: string;
  kind: CliObjectKind;
  technicalName: string;
  businessName?: string;
  definition: unknown;
}

export interface ScanOptions {
  /** Parallel reads. The CLI is a process per call, so keep this modest. Default 4. */
  concurrency?: number;
  /** Called after each object is read, for progress output. */
  onProgress?: (done: number, total: number, current: string) => void;
}

/**
 * Lists and reads every object in the given spaces, then builds the lineage
 * graph. Read-only: it only calls `listObjects` and `readObject`.
 * Failures on one kind or object become warnings; the scan carries on.
 */
export async function readSpaces(source: ObjectSource, spaces: string[], opts: ScanOptions = {}): Promise<{ raw: RawObject[]; warnings: string[] }> {
  const warnings: string[] = [];
  const todo: Omit<RawObject, "definition">[] = [];

  for (const space of spaces) {
    for (const kind of CLI_OBJECT_KINDS) {
      try {
        for (const item of await source.listObjects(space, kind)) {
          todo.push({ space, kind, technicalName: item.technicalName, businessName: item.businessName });
        }
      } catch (e) {
        warnings.push(`${space}: could not list ${kind}: ${firstLine(e)}`);
      }
    }
  }

  const raw: RawObject[] = [];
  let done = 0;
  await pool(todo, opts.concurrency ?? 4, async (item) => {
    try {
      const definition = await source.readObject(item.space, item.kind, item.technicalName);
      raw.push({ ...item, definition });
    } catch (e) {
      warnings.push(`${item.space}.${item.technicalName} (${item.kind}): could not read: ${firstLine(e)}`);
    }
    opts.onProgress?.(++done, todo.length, `${item.space}.${item.technicalName}`);
  });

  raw.sort((a, b) => `${a.space}.${a.technicalName}`.localeCompare(`${b.space}.${b.technicalName}`));
  return { raw, warnings };
}

/** Turns raw CLI output into the platform's object model and links it. Pure, so it can run on saved scans. */
export function graphFromRaw(raw: RawObject[], spaces: string[], warnings: string[] = []): LineageGraph {
  const objects: DspObject[] = raw.map((r) => ({
    space: r.space,
    technicalName: r.technicalName,
    businessName: r.businessName,
    type: classifyObject(r.kind, r.definition),
    definition: r.definition,
    definitionHash: hashDefinition(r.definition),
  }));
  return buildGraph(objects, spaces, warnings);
}

export async function scanSpaces(source: ObjectSource, spaces: string[], opts: ScanOptions = {}): Promise<LineageGraph> {
  const { raw, warnings } = await readSpaces(source, spaces, opts);
  return graphFromRaw(raw, spaces, warnings);
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** The line that says what went wrong: the CLI's own "error:" line when it printed one, not the command or its warnings. */
function firstLine(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | undefined)?.stderr;
  const text = `${typeof stderr === "string" ? stderr : ""}\n${e instanceof Error ? e.message : String(e)}`;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^error\b/i.test(l)) ?? lines.find((l) => !/^warning\b/i.test(l)) ?? "unknown error";
}
