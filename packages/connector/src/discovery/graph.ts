import {
  TABLE_TYPES,
  refKey,
  toRef,
  type DspEdge,
  type DspObject,
  type DspObjectRef,
  type LineageGraph,
  type Pipeline,
  type WriterLink,
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

  // A flow that reads the table it writes (delta or lookup on its own target) does not depend on it.
  // extractReferences already drops this within one definition; this also covers "NAME" vs "SPACE.NAME".
  const writes = new Set(edges.filter((e) => e.kind === "writes_to").map((e) => `${refKey(e.from)}>${refKey(e.to)}`));
  const kept = edges.filter((e) => !(e.kind === "reads_from" && writes.has(`${refKey(e.to)}>${refKey(e.from)}`)));

  return { scannedAt: new Date().toISOString(), spaces, nodes: objects, edges: kept, warnings };
}

export interface PipelineOptions {
  /** Defaults to the output's technical name. */
  name?: string;
  /**
   * Writers that belong to other processes. Each pattern matches a technical
   * name or SPACE.NAME, with `*` and `?` wildcards, ignoring case. A matching
   * writer of a pipeline table is listed in `excludedWriters` and its own
   * inputs are not followed.
   */
  excludeWriters?: string[];
}

/**
 * The pipeline that produces `output`, traced backwards:
 *
 *  - every object the output reads (main chain and side inputs alike, e.g.
 *    config tables and control views used in a JOIN or WHERE EXISTS), and what
 *    those read, down to the tables nothing upstream writes;
 *  - for each table, the flow that writes it. When a table has several writers,
 *    the excluded ones are listed but not followed. If more than one is still
 *    left, all of them are followed and the table is reported as ambiguous:
 *    there is no generic way to tell which one belongs;
 *  - never task chains: they run steps but are not part of the data path.
 */
export function buildPipeline(
  graph: LineageGraph,
  output: Pick<DspObjectRef, "space" | "technicalName">,
  opts: PipelineOptions = {},
): Pipeline {
  const nodeByKey = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const outputNode = nodeByKey.get(refKey(output));
  if (!outputNode) throw new Error(`Object ${refKey(output)} was not found in the scanned spaces.`);

  const patterns = (opts.excludeWriters ?? []).map(globToRegExp);
  const isExcluded = (ref: DspObjectRef) => patterns.some((re) => re.test(ref.technicalName) || re.test(refKey(ref)));

  const dataEdges = graph.edges.filter((e) => e.kind !== "triggers");
  const incoming = new Map<string, DspEdge[]>();
  for (const e of dataEdges) incoming.set(refKey(e.to), [...(incoming.get(refKey(e.to)) ?? []), e]);

  const keys = new Set<string>();
  const excludedWriters: WriterLink[] = [];
  const ambiguousWriters: Pipeline["ambiguousWriters"] = [];
  const stack = [refKey(output)];
  while (stack.length) {
    const key = stack.pop()!;
    if (keys.has(key)) continue;
    keys.add(key);
    const node = toRef(nodeByKey.get(key)!);
    const edgesIn = incoming.get(key) ?? [];
    const writers = edgesIn.filter((e) => e.kind === "writes_to").map((e) => e.from);
    const kept = writers.filter((w) => !isExcluded(w));
    for (const w of writers) if (isExcluded(w)) excludedWriters.push({ writer: w, table: node });
    if (kept.length > 1) ambiguousWriters.push({ table: node, writers: [...kept].sort(byRef) });
    for (const e of edgesIn) {
      if (e.kind === "writes_to" && isExcluded(e.from)) continue;
      stack.push(refKey(e.from));
    }
  }

  const edges = dataEdges.filter((e) => keys.has(refKey(e.from)) && keys.has(refKey(e.to)));
  const { order, cycles } = orderSteps(
    [...keys],
    edges.map((e) => [refKey(e.from), refKey(e.to)]),
  );
  const steps = order.map((k) => toRef(nodeByKey.get(k)!));

  const parents = new Map<string, string[]>();
  for (const e of edges) parents.set(refKey(e.to), [...(parents.get(refKey(e.to)) ?? []), refKey(e.from)]);
  const hasTableUpstream = (start: string) => {
    const seen = new Set<string>();
    const todo = [...(parents.get(start) ?? [])];
    while (todo.length) {
      const k = todo.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      if (k !== start && TABLE_TYPES.has(nodeByKey.get(k)!.type)) return true;
      todo.push(...(parents.get(k) ?? []));
    }
    return false;
  };
  const entryPoints = steps.filter((s) => TABLE_TYPES.has(s.type) && !hasTableUpstream(refKey(s)));

  return {
    name: opts.name ?? outputNode.technicalName,
    output: toRef(outputNode),
    entryPoints,
    steps,
    excludedWriters: excludedWriters.sort((a, b) => byRef(a.table, b.table) || byRef(a.writer, b.writer)),
    ambiguousWriters: ambiguousWriters.sort((a, b) => byRef(a.table, b.table)),
    cycles: cycles.map((c) => c.map((k) => toRef(nodeByKey.get(k)!))),
  };
}

/**
 * Orders steps so each one comes after everything it depends on (Kahn's
 * algorithm, ties broken by name so the order is stable between scans).
 *
 * Steps that depend on each other in a loop can't be put in order. Instead of
 * guessing, each loop is returned in `cycles`; the loop as a whole still takes
 * its proper place among the other steps, and its members are ordered by name.
 */
export function orderSteps(keys: string[], edges: [string, string][]): { order: string[]; cycles: string[][] } {
  const groups = stronglyConnected(keys, edges);
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((k) => groupOf.set(k, i)));

  const indegree = groups.map(() => 0);
  const outgoing = groups.map(() => new Set<number>());
  for (const [from, to] of edges) {
    const a = groupOf.get(from);
    const b = groupOf.get(to);
    if (a === undefined || b === undefined || a === b || outgoing[a].has(b)) continue;
    outgoing[a].add(b);
    indegree[b]++;
  }

  const ready = groups.map((_, i) => i).filter((i) => indegree[i] === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => byName(groups[a][0], groups[b][0]));
    const g = ready.shift()!;
    order.push(...groups[g]);
    for (const next of outgoing[g]) if (--indegree[next] === 0) ready.push(next);
  }
  return { order, cycles: groups.filter((g) => g.length > 1) };
}

/** Tarjan's algorithm: groups of steps that can all reach each other. A step outside any loop is a group of one. */
function stronglyConnected(keys: string[], edges: [string, string][]): string[][] {
  const next = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const [from, to] of edges) if (next.has(to)) next.get(from)?.push(to);

  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];

  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v)!) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      groups.push(group.sort(byName));
    }
  };

  for (const k of keys) if (!index.has(k)) visit(k);
  return groups;
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byRef(a: DspObjectRef, b: DspObjectRef): number {
  return byName(refKey(a), refKey(b));
}
