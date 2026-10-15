import { refKey, type DspObjectRef, type LineageGraph, type ObjectType, type Pipeline } from "@ystara/shared";

/**
 * Renders a graph or a pipeline as a Mermaid flowchart. GitHub, VS Code and
 * most Markdown viewers draw these natively, which gives us a lineage picture
 * long before the web UI exists.
 */
const SHAPE: Record<ObjectType, [string, string]> = {
  remote_table: ["[(", ")]"],
  local_table: ["[(", ")]"],
  replication_flow: ["[/", "/]"],
  data_flow: ["[/", "/]"],
  transformation_flow: ["[/", "/]"],
  sql_view: ["[", "]"],
  graphical_view: ["[", "]"],
  analytic_model: ["{{", "}}"],
  task_chain: ["([", "])"],
  intelligent_lookup: ["[", "]"],
  unknown: ["[", "]"],
};

const LABEL: Record<ObjectType, string> = {
  remote_table: "remote table",
  local_table: "local table",
  replication_flow: "replication flow",
  data_flow: "data flow",
  transformation_flow: "transformation flow",
  sql_view: "SQL view",
  graphical_view: "graphical view",
  analytic_model: "analytic model",
  task_chain: "task chain",
  intelligent_lookup: "intelligent lookup",
  unknown: "unknown type",
};

export function toMermaid(graph: LineageGraph, pipeline?: Pipeline): string {
  const include = pipeline
    ? new Set([...pipeline.steps, ...pipeline.orchestrators].map(refKey))
    : new Set(graph.nodes.map(refKey));
  const entry = new Set((pipeline?.entryPoints ?? []).map(refKey));
  const multiSpace = graph.spaces.length > 1;

  const id = (r: Pick<DspObjectRef, "space" | "technicalName">) => "n_" + refKey(r).replace(/[^A-Za-z0-9_]/g, "_");
  const lines = ["flowchart LR"];

  for (const n of graph.nodes) {
    if (!include.has(refKey(n))) continue;
    const [open, close] = SHAPE[n.type];
    const title = multiSpace ? `${n.space}.${n.technicalName}` : n.technicalName;
    lines.push(`  ${id(n)}${open}"${escape(title)}<br/><small>${LABEL[n.type]}</small>"${close}`);
  }
  for (const e of graph.edges) {
    if (!include.has(refKey(e.from)) || !include.has(refKey(e.to))) continue;
    lines.push(e.kind === "triggers" ? `  ${id(e.from)} -.->|runs| ${id(e.to)}` : e.kind === "writes_to" ? `  ${id(e.from)} ==>|writes| ${id(e.to)}` : `  ${id(e.from)} --> ${id(e.to)}`);
  }
  if (pipeline) {
    lines.push("  classDef entry stroke-width:3px,stroke:#0a6ed1");
    lines.push("  classDef output stroke-width:3px,stroke:#188918");
    for (const k of entry) lines.push(`  class ${id(parseKey(k))} entry`);
    lines.push(`  class ${id(pipeline.output)} output`);
  }
  return lines.join("\n");
}

function parseKey(key: string): Pick<DspObjectRef, "space" | "technicalName"> {
  const i = key.indexOf(".");
  return { space: key.slice(0, i), technicalName: key.slice(i + 1) };
}

function escape(s: string): string {
  return s.replace(/"/g, "#quot;");
}
