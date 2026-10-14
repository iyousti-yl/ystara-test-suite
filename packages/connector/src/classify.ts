import { createHash } from "node:crypto";
import type { ObjectType } from "@ystara/shared";

/**
 * Maps CLI object kinds to our ObjectType. Unknown kinds are kept, not dropped,
 * so a pipeline graph never silently loses a step.
 */
const KIND_MAP: Record<string, ObjectType> = {
  "remote-tables": "remote_table",
  "local-tables": "local_table",
  tables: "local_table",
  "replication-flows": "replication_flow",
  "data-flows": "data_flow",
  "transformation-flows": "transformation_flow",
  "sql-views": "sql_view",
  views: "sql_view",
  "graphical-views": "graphical_view",
  "analytic-models": "analytic_model",
  "task-chains": "task_chain",
  "intelligent-lookups": "intelligent_lookup",
};

export function classifyKind(cliKind: string): ObjectType {
  return KIND_MAP[cliKind] ?? "unknown";
}

/** Object types the CLI is expected to be able to create in a test space. Confirmed or corrected by the spike. */
export const DEPLOYABLE: ReadonlySet<ObjectType> = new Set<ObjectType>([
  "local_table",
  "sql_view",
  "graphical_view",
  "transformation_flow",
  "data_flow",
  "analytic_model",
  "task_chain",
]);

export function hashDefinition(definition: unknown): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}
