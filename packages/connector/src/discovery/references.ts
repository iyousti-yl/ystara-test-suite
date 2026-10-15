import { FLOW_TYPES, type ObjectType } from "@ystara/shared";

/**
 * Finds which other objects a definition refers to, and in what role.
 *
 * Datasphere stores tables and views as CSN, while flows and task chains use
 * their own JSON shapes that differ by CLI release. Instead of a parser per
 * shape, we walk the whole definition and look for strings that match the name
 * of an object we already know from the listing. Three rules decide the role:
 *
 *  1. In a flow, a reference under a key containing "target" is what the flow
 *     writes to; every other reference is something it reads.
 *  2. In a task chain, every reference is a step it triggers.
 *  3. In tables, views and analytic models, every reference is a read
 *     (CSN association "target"s point at dimensions, which are reads too).
 *
 * SQL text (SQL views, SQL script transformations) is scanned for identifiers
 * that match known names.
 *
 * Known gaps, to close once we have real samples: a column named exactly like
 * an object would produce a false edge; objects shared from a space that was
 * not scanned are not resolved.
 */

export type RefRole = "source" | "target" | "step";

export interface ExtractedRef {
  /** Key as it appears in `known` (either "NAME" for the same space or "SPACE.NAME"). */
  name: string;
  role: RefRole;
}

const SQL_HINT = /\bselect\b[\s\S]*\bfrom\b/i;
const IDENTIFIER = /"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/g;

export function extractReferences(
  definition: unknown,
  selfName: string,
  selfType: ObjectType,
  known: ReadonlySet<string>,
): ExtractedRef[] {
  const found = new Map<string, RefRole>();
  const isFlow = FLOW_TYPES.has(selfType);

  const add = (name: string, path: readonly string[]) => {
    if (name === selfName || !known.has(name)) return;
    let role: RefRole = "source";
    if (selfType === "task_chain") role = "step";
    else if (isFlow && path.some((k) => k.toLowerCase().includes("target"))) role = "target";
    // A flow that both reads and writes the same table (delta/upsert) keeps "target": the write matters for lineage.
    if (found.get(name) !== "target") found.set(name, role);
  };

  const visit = (value: unknown, path: string[]) => {
    if (typeof value === "string") {
      if (known.has(value)) add(value, path);
      else if (SQL_HINT.test(value)) for (const id of sqlIdentifiers(value)) add(id, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, path));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, [...path, k]);
    }
  };

  visit(focus(definition, selfName), []);
  return [...found].map(([name, role]) => ({ name, role }));
}

/**
 * A CLI `read` can return the object's own definition together with the
 * definitions of objects it depends on (CSN `definitions` map). Scanning the
 * dependencies too would invent edges from their sources to us, so when the
 * object's own entry is present we scan only that entry, plus any other
 * top-level section keyed by our name (e.g. `transformationflows.<name>`).
 */
export function focus(definition: unknown, selfName: string): unknown {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return definition;
  const root = definition as Record<string, unknown>;
  const parts: unknown[] = [];
  for (const section of Object.values(root)) {
    if (section && typeof section === "object" && !Array.isArray(section) && selfName in section) {
      parts.push((section as Record<string, unknown>)[selfName]);
    }
  }
  return parts.length > 0 ? parts : definition;
}

function sqlIdentifiers(sql: string): Set<string> {
  const ids = new Set<string>();
  for (const m of sql.matchAll(IDENTIFIER)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    ids.add(raw);
    // "SPACE"."OBJECT" arrives as two quoted identifiers; the second half is caught on its own.
  }
  // Also join consecutive quoted parts: "SPACE"."OBJECT" -> SPACE.OBJECT
  for (const m of sql.matchAll(/"([^"]+)"\s*\.\s*"([^"]+)"/g)) ids.add(`${m[1]}.${m[2]}`);
  return ids;
}
