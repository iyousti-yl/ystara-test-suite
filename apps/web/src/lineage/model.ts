import { refKey, type DspEdge, type GraphNode, type Pipeline } from "@ystara/shared";

/**
 * Turns a pipeline (from the API) into what the lineage picture draws: one
 * node per object with the facts worth showing on it, and one edge per data link.
 * Pure data, no React, so it is easy to test.
 */
export interface LineageNode {
  key: string;
  ref: GraphNode;
  /** The object the pipeline produces. */
  output: boolean;
  /** A table with no other table upstream: where fixtures go. */
  entry: boolean;
  /** A writer that belongs to another process (by configuration): drawn, but its inputs are not followed. */
  excluded: boolean;
  /** A table that still has more than one writer: the pipeline may include another process. */
  severalWriters: boolean;
  /** One of the writers of such a table: excluding the one that doesn't belong is the fix. */
  competingWriter: boolean;
  /** Part of a loop, so the step order around it is a guess. */
  inLoop: boolean;
}

export interface LineageEdge {
  key: string;
  from: string;
  to: string;
  kind: DspEdge["kind"];
  /** The link from an excluded writer to the table it writes. */
  excluded: boolean;
}

export function lineageModel(pipeline: Pipeline, graph: { nodes: GraphNode[]; edges: DspEdge[] }): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const excluded = new Set(pipeline.excludedWriters.map((x) => refKey(x.writer)));
  const entry = new Set(pipeline.entryPoints.map(refKey));
  const ambiguousTables = new Set(pipeline.ambiguousWriters.map((a) => refKey(a.table)));
  const competing = new Set(pipeline.ambiguousWriters.flatMap((a) => a.writers.map(refKey)));
  const inLoop = new Set(pipeline.cycles.flat().map(refKey));

  // Steps in pipeline order first (upstream to output), then the excluded writers.
  const order = new Map([...pipeline.steps.map(refKey), ...excluded].map((key, i) => [key, i]));
  const nodes = graph.nodes
    .map((ref): LineageNode => {
      const key = refKey(ref);
      return {
        key,
        ref,
        output: key === refKey(pipeline.output),
        entry: entry.has(key),
        excluded: excluded.has(key),
        severalWriters: ambiguousTables.has(key),
        competingWriter: competing.has(key),
        inLoop: inLoop.has(key),
      };
    })
    .sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));

  const edges = graph.edges.map(
    (e): LineageEdge => ({
      key: `${refKey(e.from)}>${refKey(e.to)}>${e.kind}`,
      from: refKey(e.from),
      to: refKey(e.to),
      kind: e.kind,
      excluded: excluded.has(refKey(e.from)),
    }),
  );
  return { nodes, edges };
}

/** The exclusion pattern for a writer: its name, or SPACE.NAME when the pipeline spans several spaces. */
export function exclusionFor(ref: GraphNode, pipeline: Pipeline): string {
  const spaces = new Set(pipeline.steps.map((s) => s.space));
  return spaces.size > 1 ? refKey(ref) : ref.technicalName;
}
