import type { ObjectType } from "@ystara/shared";

/**
 * How each Datasphere object type is named and coloured in the app: views in
 * sapphire, flows in amethyst, tables in grey, analytic models in amber (the
 * brand tokens of brand.ts, so they follow light and dark mode). The colour
 * marks a node's left edge or a dot, never text.
 */
export type Category = "table" | "flow" | "view" | "model" | "other";

export const OBJECT_TYPE: Record<ObjectType, { label: string; category: Category }> = {
  local_table: { label: "Local table", category: "table" },
  remote_table: { label: "Remote table", category: "table" },
  data_flow: { label: "Data flow", category: "flow" },
  transformation_flow: { label: "Transformation flow", category: "flow" },
  replication_flow: { label: "Replication flow", category: "flow" },
  sql_view: { label: "SQL view", category: "view" },
  graphical_view: { label: "Graphical view", category: "view" },
  analytic_model: { label: "Analytic model", category: "model" },
  task_chain: { label: "Task chain", category: "other" },
  intelligent_lookup: { label: "Intelligent lookup", category: "other" },
  unknown: { label: "Unknown type", category: "other" },
};

export const CATEGORY_COLOR: Record<Category, string> = {
  table: "var(--ystara-grey)",
  flow: "var(--ystara-amethyst)",
  view: "var(--ystara-sapphire)",
  model: "var(--ystara-amber)",
  other: "var(--ystara-border)",
};

export const typeLabel = (type: ObjectType) => OBJECT_TYPE[type]?.label ?? type;
export const typeColor = (type: ObjectType) => CATEGORY_COLOR[OBJECT_TYPE[type]?.category ?? "other"];
