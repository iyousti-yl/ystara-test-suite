import { FLOW_TYPES, type ObjectType } from "@ystara/shared";

/**
 * Finds which other objects a definition refers to, and in what role.
 *
 * Datasphere stores tables and views as CSN, while flows and task chains use
 * their own JSON shapes that differ by CLI release. Instead of a parser per
 * shape, we walk the whole definition and look for strings that match the name
 * of an object we already know from the listing. These rules decide the role:
 *
 *  1. In a flow, each step under `contents.processes` names its `component`.
 *     A writing component (`...producer`, `...target`, e.g.
 *     `com.sap.database.table.producer`, `com.sap.dwc.target`) makes every
 *     reference inside that step a write; a reading component (`...consumer`,
 *     `...source`, e.g. `com.sap.application.consumer.v2`) makes them reads.
 *     The step's own name (`producer1`, `target1`, ...) does not matter.
 *  2. In a flow, the keys of a `targets` section (`dataflows.<DF>.targets`)
 *     are writes and the keys of a `sources` section are reads.
 *  3. In a flow, any other reference is a write when its key path contains
 *     "target" (e.g. a replication task's `targetObject`) and a read otherwise.
 *  4. In a task chain, every reference is a step it triggers.
 *  5. In tables, views and analytic models, every reference is a read
 *     (CSN association "target"s point at dimensions, which are reads too).
 *
 * A flow that reads the table it writes (a delta or lookup on its own target)
 * keeps only the write: reading your own output is not a dependency.
 *
 * SQL text (SQL views, SQL steps of transformation flows) is scanned for
 * identifiers that match known names, after removing comments, so a table in
 * a commented-out JOIN is not a dependency.
 *
 * Known gaps: a column named exactly like an object produces a false edge;
 * objects shared from a space that was not scanned are not resolved.
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

  /** `stepRole` is the role set by the enclosing flow step's component, if it has a recognised one. */
  const roleFor = (path: readonly string[], stepRole: RefRole | undefined): RefRole => {
    if (selfType === "task_chain") return "step";
    if (!isFlow) return "source";
    if (stepRole) return stepRole;
    return path.some((k) => k.toLowerCase().includes("target")) ? "target" : "source";
  };

  const add = (name: string, role: RefRole) => {
    if (name === selfName || !known.has(name)) return;
    // A flow that reads and writes the same table keeps "target": the write is what matters for lineage.
    if (found.get(name) !== "target") found.set(name, role);
  };

  const visit = (value: unknown, path: string[], stepRole: RefRole | undefined) => {
    if (typeof value === "string") {
      const role = roleFor(path, stepRole);
      if (known.has(value)) add(value, role);
      else if (SQL_HINT.test(value)) {
        const sql = stripSqlComments(value);
        if (SQL_HINT.test(sql)) for (const id of sqlIdentifiers(sql)) add(id, role);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, path, stepRole));
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const role = isFlow && typeof obj.component === "string" ? (componentRole(obj.component) ?? stepRole) : stepRole;
      const section = path.at(-1)?.toLowerCase();
      for (const [k, v] of Object.entries(obj)) {
        if (isFlow && section === "targets") add(k, "target");
        else if (isFlow && section === "sources") add(k, "source");
        visit(v, [...path, k], role);
      }
    }
  };

  visit(focus(definition, selfName), [], undefined);
  return [...found].map(([name, role]) => ({ name, role }));
}

/**
 * Whether a flow step's component writes or reads. Matches on the dotted
 * segments, so `com.sap.database.table.producer` and `com.sap.dwc.target`
 * write, `com.sap.application.consumer.v2` and `com.sap.database.table.consumer`
 * read, and operators (projection, join, script, ...) return undefined.
 */
export function componentRole(component: string): "source" | "target" | undefined {
  const segments = component.toLowerCase().split(".");
  if (segments.some((s) => s.startsWith("producer") || s.startsWith("target"))) return "target";
  if (segments.some((s) => s.startsWith("consumer") || s.startsWith("source"))) return "source";
  return undefined;
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

/**
 * Replaces SQL comments (`--` to the end of the line, and slash-star blocks)
 * with spaces. Comment markers inside 'string literals' and "quoted
 * identifiers" are left alone, and so is everything else.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      // Copy the quoted part as-is; a doubled quote ('' or "") is an escaped quote inside it.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
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
