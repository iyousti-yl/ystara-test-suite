import { refKey, type DspEdge, type DspObjectRef, type GraphNode, type Measurability, type Pipeline, type Verdict } from "@ystara/shared";

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
  /** Whether a snapshot can measure it with SQL, and if not, why. Undefined for an excluded writer, which is no step. */
  measurement?: Measurability;
  /** On a comparison of two snapshots: what changed in this step (StepMark). */
  mark?: StepMark;
}

export interface LineageEdge {
  key: string;
  from: string;
  to: string;
  kind: DspEdge["kind"];
  /** The link from an excluded writer to the table it writes. */
  excluded: boolean;
}

export function lineageModel(
  pipeline: Pipeline,
  graph: { nodes: GraphNode[]; edges: DspEdge[] },
  measurement: Record<string, Measurability> = {},
): { nodes: LineageNode[]; edges: LineageEdge[] } {
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
        measurement: measurement[key],
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

/** Why a snapshot can't measure a step, in a sentence for the object's details. */
export function whyNotMeasurable(reason: Exclude<Measurability, { measurable: true }>["reason"], ref: GraphNode): string {
  const space = ref.space;
  switch (reason) {
    case "process":
      return "A flow or task chain holds no data of its own: snapshots measure the tables and views around it.";
    case "no-database-user":
      return `Snapshots can't measure it yet: space ${space} has no database user. An admin adds one on the tenant page.`;
    case "not-checked":
      return `Snapshots can measure it once the database user of ${space} has been checked.`;
    case "check-failed":
      return `Snapshots can't measure it: the database user of ${space} failed its last check (see the tenant page).`;
    case "not-visible":
      return ref.type === "sql_view" || ref.type === "graphical_view"
        ? `Snapshots can't measure it: it isn't exposed for consumption, so the database user of ${space} doesn't see it. A Datasphere modeler can switch on Expose for Consumption in its properties. Ystara never changes the tenant.`
        : `Snapshots can't measure it: the database user of ${space} doesn't see it. Database users only see what is exposed for consumption.`;
  }
}

/** The same, in a few words for a table of steps. */
export function notMeasurableLabel(reason: Exclude<Measurability, { measurable: true }>["reason"]): string {
  return {
    process: "A flow or task chain: no data of its own",
    "no-database-user": "No database user for its space",
    "not-checked": "Its database user isn't checked yet",
    "check-failed": "Its database user failed its check",
    "not-visible": "Not exposed for consumption",
  }[reason];
}

/**
 * What a comparison of two snapshots says about a step, drawn on its node: a
 * verdict for a step measured in both; "not_compared" for one measured in
 * only one of them (its definition unchanged); "added" for a step only the
 * later snapshot has. A step measured in neither is marked only when its
 * definition changed.
 */
export type StepMark = Verdict | "not_compared" | "added";

export function stepMarks(c: { compared: (DspObjectRef & { verdict: Verdict })[]; measuredOnce: StepChangeRef[]; definitionsOnly: StepChangeRef[]; added: DspObjectRef[] }) {
  const marks = new Map<string, StepMark>();
  for (const o of c.compared) marks.set(refKey(o), o.verdict);
  for (const s of c.measuredOnce) marks.set(refKey(s), s.definitionChanged ? "definition_changed" : "not_compared");
  for (const s of c.definitionsOnly) if (s.definitionChanged) marks.set(refKey(s), "definition_changed");
  for (const a of c.added) marks.set(refKey(a), "added");
  return marks;
}
type StepChangeRef = DspObjectRef & { definitionChanged: boolean };

export const MARK_LABEL: Record<StepMark, string> = {
  unchanged: "Unchanged",
  data_changed: "Data changed",
  definition_changed: "Definition changed",
  both: "Data and definition changed",
  not_compared: "Not compared",
  added: "New step",
};
