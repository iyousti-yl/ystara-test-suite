import type { DspEdge, DspObject, DspObjectRef, Pipeline } from "./objects.js";

/**
 * What the API stores and sends, shared by the API (which sends it) and the web
 * app (which reads it). The records live here rather than in @ystara/db so the
 * browser code never depends on the database package.
 *
 * Over HTTP, dates arrive as ISO strings: the web app reads `Json<Scan>`, not `Scan`.
 */

export interface Tenant {
  id: string;
  name: string;
  /** Datasphere URL. Null for a tenant that only has imported scans. */
  host: string | null;
  createdAt: Date;
}

/**
 * Discovery scans: a request to read some spaces of a tenant, and, once done,
 * what was read (object definitions) and the lineage graph built from it.
 *
 * Lifecycle: queued (API) -> running (worker) -> succeeded | failed.
 * Imported scans (a saved `npm run scan` folder) go straight to succeeded.
 */
export type ScanStatus = "queued" | "running" | "succeeded" | "failed";
export type ScanSource = "tenant" | "import";

export interface Scan {
  id: string;
  tenantId: string;
  spaces: string[];
  source: ScanSource;
  status: ScanStatus;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  objectCount: number | null;
  edgeCount: number | null;
  warnings: string[];
  error: string | null;
}

/**
 * A saved pipeline: an output object plus the writers that belong to other
 * processes. The steps are not stored; they are computed from the tenant's
 * latest successful scan.
 */
export interface PipelineDefinition {
  id: string;
  tenantId: string;
  name: string;
  output: { space: string; technicalName: string };
  /** Patterns as for `npm run scan -- --exclude-writer`: NAME or SPACE.NAME, `*` and `?` wildcards. */
  excludeWriters: string[];
  createdAt: Date;
}

/** An object as the lineage pictures need it: no definition. */
export interface GraphNode extends DspObjectRef {
  businessName?: string;
}

/** GET /api/scans/:id/graph: every object and edge of a scan, without definitions. */
export interface ScanGraph {
  scannedAt: string;
  spaces: string[];
  nodes: Omit<DspObject, "definition">[];
  edges: DspEdge[];
  warnings: string[];
}

/** GET /api/scans/:id/pipeline: the pipeline behind one output on one scan. */
export interface PipelineResult {
  scanId: string;
  excludeWriters: string[];
  pipeline: Pipeline;
  /** What to draw: every step and excluded writer, and the data edges between them. */
  graph: { nodes: GraphNode[]; edges: DspEdge[] };
  mermaid: string;
}

/** GET /api/pipelines/:id: a saved pipeline, computed on the tenant's latest successful scan. */
export interface SavedPipelineResult extends PipelineResult {
  definition: PipelineDefinition;
}

/** GET /api/scans/:id/objects/:space/:name: one object with its definition and every edge that touches it. */
export interface ObjectDetails {
  object: DspObject;
  edges: DspEdge[];
}

/** A value as it arrives over HTTP (JSON): dates become ISO strings. */
export type Json<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
