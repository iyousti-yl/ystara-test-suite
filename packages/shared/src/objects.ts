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

export interface DspObjectRef {
  space: string;
  technicalName: string;
  type: ObjectType;
}

export interface DspObject extends DspObjectRef {
  businessName?: string;
  /** Raw definition (CSN or CLI JSON). Stored as-is for re-parsing and for test-copy generation. */
  definition: unknown;
  /** Stable hash of `definition`, used to detect changes between scans. */
  definitionHash: string;
  /** Whether the CLI can deploy a modified copy of this object into a test space. */
  deployable: boolean;
}

/** Edge kinds in the lineage graph. */
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
}

/**
 * A pipeline is the unit tests attach to: one output object plus every upstream
 * step needed to produce it. Steps are ordered so they can be executed top-down.
 */
export interface Pipeline {
  id: string;
  name: string;
  output: DspObjectRef;
  /** Ingestion points where fixtures can be injected (usually local tables filled by flows). */
  entryPoints: DspObjectRef[];
  steps: DspObjectRef[];
}
