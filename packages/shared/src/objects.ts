/**
 * Datasphere object model as the platform sees it.
 *
 * The discovery module turns CLI exports into these nodes and edges. Everything
 * downstream (pipelines, snapshots, scenarios) works on this graph, never on raw
 * CLI output, so a CLI format change only touches the connector package.
 */

/** Object types we know how to discover. "unknown" keeps the graph complete when SAP adds types. */
export const OBJECT_TYPES = [
  "remote_table",
  "local_table",
  "replication_flow",
  "data_flow",
  "transformation_flow",
  "sql_view",
  "graphical_view",
  "analytic_model",
  "task_chain",
  "intelligent_lookup",
  "unknown",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

/** Types that hold data at rest. Fixtures are injected into these; everything else computes or moves data. */
export const TABLE_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>(["local_table", "remote_table"]);

/** Types that copy data into a target table when they run. */
export const FLOW_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>([
  "data_flow",
  "transformation_flow",
  "replication_flow",
]);

export interface DspObjectRef {
  space: string;
  technicalName: string;
  type: ObjectType;
}

export interface DspObject extends DspObjectRef {
  businessName?: string;
  /** Raw definition as returned by the CLI. Stored as-is so it can be re-parsed when the parser improves. */
  definition: unknown;
  /** Stable hash of `definition`, used to detect changes between scans. */
  definitionHash: string;
}

/**
 * Edges always point in the direction data (or control) moves:
 *  - reads_from: `from` is the source, `to` is the object that reads it (table -> view, view -> flow)
 *  - writes_to:  `from` is a flow, `to` is the table it loads
 *  - triggers:   `from` is a task chain, `to` is a step it runs (control only, no data)
 */
export type EdgeKind = "reads_from" | "writes_to" | "triggers";

export interface DspEdge {
  from: DspObjectRef;
  to: DspObjectRef;
  kind: EdgeKind;
}

export interface LineageGraph {
  scannedAt: string;
  spaces: string[];
  nodes: DspObject[];
  edges: DspEdge[];
  /** Objects that could not be read or parsed. A scan never fails as a whole because of one object. */
  warnings: string[];
}

/**
 * A pipeline is the unit tests attach to: one output object plus every upstream
 * step needed to produce it, ordered so each step comes after everything it depends on.
 * Side inputs (config and control tables or views) are steps like any other.
 * Task chains are orchestration and never part of a pipeline.
 */
export interface Pipeline {
  name: string;
  output: DspObjectRef;
  /** Tables with no other table upstream: where fixtures are injected or snapshots start. */
  entryPoints: DspObjectRef[];
  /** Every object in the chain, upstream first, output last. */
  steps: DspObjectRef[];
  /** Writers of a pipeline table that belong to other processes (by configuration). Listed, not followed upstream. */
  excludedWriters: WriterLink[];
  /**
   * Tables that still have more than one writer after exclusions. Every one of
   * those writers was followed, so the steps may include another process; add
   * exclusions until only the writer that belongs is left.
   */
  ambiguousWriters: { table: DspObjectRef; writers: DspObjectRef[] }[];
  /** Groups of steps that depend on each other in a loop. Empty when the order is sound. */
  cycles: DspObjectRef[][];
}

export interface WriterLink {
  writer: DspObjectRef;
  table: DspObjectRef;
}

export function refKey(ref: Pick<DspObjectRef, "space" | "technicalName">): string {
  return `${ref.space}.${ref.technicalName}`;
}

export function toRef(o: DspObjectRef): DspObjectRef {
  return { space: o.space, technicalName: o.technicalName, type: o.type };
}
