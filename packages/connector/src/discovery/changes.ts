import { refKey, type ChangedStep, type DspObjectRef, type LineageGraph } from "@ystara/shared";
import { buildPipeline } from "./graph.js";

/**
 * What changed in a pipeline from one scan to the next: the steps whose
 * definition hash differs, and the steps only one of the two pipelines has
 * (a new writer, a view that was removed). The pipeline is built on each scan
 * as it is saved (output and exclusions), so a step counts only where it is
 * part of the pipeline. Pure: no CLI calls, only stored graphs.
 *
 * `before` is undefined, or lacks the output, when there is nothing to compare
 * with: then every step of `after` counts as added. When `after` lacks the
 * output, every step of `before` counts as removed, since the scenarios can't
 * run any more. Empty when nothing changed.
 */
export function changedSteps(
  before: LineageGraph | undefined,
  after: LineageGraph,
  pipeline: { output: Pick<DspObjectRef, "space" | "technicalName">; excludeWriters: string[] },
): ChangedStep[] {
  const stepsOf = (graph: LineageGraph | undefined) => {
    if (!graph || !graph.nodes.some((n) => refKey(n) === refKey(pipeline.output))) return undefined;
    const hashes = new Map(graph.nodes.map((n) => [refKey(n), n.definitionHash]));
    return new Map(buildPipeline(graph, pipeline.output, { excludeWriters: pipeline.excludeWriters }).steps.map((s) => [refKey(s), { step: s, hash: hashes.get(refKey(s)) }]));
  };
  const none = new Map<string, { step: DspObjectRef; hash: string | undefined }>();
  const now = stepsOf(after) ?? none;
  const then = stepsOf(before) ?? none;

  const ref = ({ space, technicalName, type }: DspObjectRef) => ({ space, technicalName, type });
  const changed: ChangedStep[] = [];
  for (const [key, { step, hash }] of now) {
    const old = then.get(key);
    if (!old) changed.push({ ...ref(step), change: "added" });
    else if (old.hash !== hash) changed.push({ ...ref(step), change: "definition" });
  }
  for (const [key, { step }] of then) if (!now.has(key)) changed.push({ ...ref(step), change: "removed" });
  return changed;
}
