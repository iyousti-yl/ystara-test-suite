import {
  TABLE_TYPES,
  refKey,
  toRef,
  type DspEdge,
  type DspObject,
  type DspObjectRef,
  type LineageGraph,
  type Pipeline,
} from "@ystara/shared";
import { extractReferences } from "./references.js";

/**
 * Builds the lineage graph from objects that have already been read.
 *
 * Names are resolved within the object's own space first ("NAME"), then across
 * every scanned space ("SPACE.NAME"), so scanning several spaces together links
 * shared objects.
 */
export function buildGraph(objects: DspObject[], spaces: string[], warnings: string[] = []): LineageGraph {
  const byKey = new Map(objects.map((o) => [refKey(o), o]));
  const edges: DspEdge[] = [];
  const seen = new Set<string>();

  for (const obj of objects) {
    const known = new Set<string>();
    for (const other of objects) {
      known.add(refKey(other));
      if (other.space === obj.space) known.add(other.technicalName);
    }

    for (const ref of extractReferences(obj.definition, obj.technicalName, obj.type, known)) {
      const other = byKey.get(ref.name.includes(".") && byKey.has(ref.name) ? ref.name : `${obj.space}.${ref.name}`);
      if (!other || other === obj) continue;
      const edge: DspEdge =
        ref.role === "target"
          ? { from: toRef(obj), to: toRef(other), kind: "writes_to" }
          : ref.role === "step"
            ? { from: toRef(obj), to: toRef(other), kind: "triggers" }
            : { from: toRef(other), to: toRef(obj), kind: "reads_from" };
      const id = `${refKey(edge.from)}>${refKey(edge.to)}>${edge.kind}`;
      if (!seen.has(id)) {
        seen.add(id);
        edges.push(edge);
      }
    }
  }

  return { scannedAt: new Date().toISOString(), spaces, nodes: objects, edges, warnings };
}

const isData = (e: DspEdge) => e.kind !== "triggers";

/** Every object the output depends on through data edges, including the output itself. */
export function upstreamKeys(graph: LineageGraph, output: Pick<DspObjectRef, "space" | "technicalName">): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges.filter(isData)) {
    const list = incoming.get(refKey(e.to)) ?? [];
    list.push(refKey(e.from));
    incoming.set(refKey(e.to), list);
  }
  const result = new Set<string>();
  const stack = [refKey(output)];
  while (stack.length) {
    const key = stack.pop()!;
    if (result.has(key)) continue;
    result.add(key);
    stack.push(...(incoming.get(key) ?? []));
  }
  return result;
}

/**
 * The pipeline that produces `output`: all upstream objects in dependency
 * order, the entry tables (no other table upstream of them), and the task
 * chains that run any of the steps.
 */
export function buildPipeline(graph: LineageGraph, output: Pick<DspObjectRef, "space" | "technicalName">, name?: string): Pipeline {
  const nodeByKey = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const outputNode = nodeByKey.get(refKey(output));
  if (!outputNode) throw new Error(`Object ${refKey(output)} was not found in the scanned spaces.`);

  const keys = upstreamKeys(graph, output);
  const dataEdges = graph.edges.filter((e) => isData(e) && keys.has(refKey(e.from)) && keys.has(refKey(e.to)));

  const steps = topoSort([...keys], dataEdges).map((k) => toRef(nodeByKey.get(k)!));

  const entryPoints = steps.filter((s) => {
    if (!TABLE_TYPES.has(s.type)) return false;
    const above = upstreamKeys({ ...graph, edges: dataEdges }, s);
    above.delete(refKey(s));
    return ![...above].some((k) => TABLE_TYPES.has(nodeByKey.get(k)!.type));
  });

  const orchestrators = new Map<string, DspObjectRef>();
  for (const e of graph.edges) {
    if (e.kind === "triggers" && keys.has(refKey(e.to))) orchestrators.set(refKey(e.from), e.from);
  }

  return {
    name: name ?? outputNode.technicalName,
    output: toRef(outputNode),
    entryPoints,
    steps,
    orchestrators: [...orchestrators.values()],
  };
}

/**
 * Kahn's algorithm. Ties are broken alphabetically so the order is stable
 * between scans. If the graph has a cycle (it shouldn't in Datasphere), the
 * remaining nodes are appended alphabetically instead of looping forever.
 */
function topoSort(keys: string[], edges: DspEdge[]): string[] {
  const indegree = new Map(keys.map((k) => [k, 0]));
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const from = refKey(e.from);
    const to = refKey(e.to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }
  const ready = keys.filter((k) => indegree.get(k) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const k = ready.shift()!;
    order.push(k);
    for (const next of outgoing.get(k) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  const rest = keys.filter((k) => !order.includes(k)).sort();
  return [...order, ...rest];
}
