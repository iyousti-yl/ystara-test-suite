import { createHash } from "node:crypto";
import type { ObjectType } from "@ystara/shared";
import type { CliObjectKind } from "./readonly.js";

/**
 * Maps CLI object kinds to our ObjectType. Unknown kinds are kept as "unknown",
 * not dropped, so a pipeline graph never silently loses a step.
 */
const KIND_MAP: Record<string, ObjectType> = {
  "remote-tables": "remote_table",
  "local-tables": "local_table",
  "replication-flows": "replication_flow",
  "data-flows": "data_flow",
  "transformation-flows": "transformation_flow",
  views: "sql_view",
  "analytic-models": "analytic_model",
  "task-chains": "task_chain",
  "intelligent-lookups": "intelligent_lookup",
};

export function classifyKind(cliKind: string): ObjectType {
  return KIND_MAP[cliKind] ?? "unknown";
}

/**
 * Like classifyKind, but uses the definition to split the merged `views`
 * command back into SQL and graphical views (graphical views carry a query
 * builder model annotation).
 */
export function classifyObject(cliKind: CliObjectKind | string, definition: unknown): ObjectType {
  const type = classifyKind(cliKind);
  if (type === "sql_view" && JSON.stringify(definition ?? null).includes("@DataWarehouse.querybuilder.model")) {
    return "graphical_view";
  }
  return type;
}

/** Hash of a definition that ignores key order, so re-scans of an unchanged object give the same hash. */
export function hashDefinition(definition: unknown): string {
  return createHash("sha256").update(stableStringify(definition)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
