import { describe, expect, it } from "vitest";
import type { DspEdge, DspObjectRef, GraphNode, Pipeline } from "@ystara/shared";
import { layoutLeftToRight } from "./layout";
import { exclusionFor, lineageModel } from "./model";

// Synthetic pipeline: DF_LOAD and DF_OTHER both write LT_DATA (DF_OTHER excluded), V_OUT reads LT_DATA and LT_CONFIG.
const ref = (technicalName: string, type: DspObjectRef["type"], space = "S"): GraphNode => ({ space, technicalName, type });
const DF_LOAD = ref("DF_LOAD", "data_flow");
const DF_OTHER = ref("DF_OTHER", "data_flow");
const LT_DATA = ref("LT_DATA", "local_table");
const LT_CONFIG = ref("LT_CONFIG", "local_table");
const LT_SRC = ref("LT_SRC", "local_table");
const V_OUT = { ...ref("V_OUT", "sql_view"), businessName: "Output" };
const edge = (from: GraphNode, to: GraphNode, kind: DspEdge["kind"]): DspEdge => ({ from, to, kind });

const pipeline: Pipeline = {
  name: "V_OUT",
  output: V_OUT,
  entryPoints: [LT_CONFIG, LT_SRC],
  steps: [LT_CONFIG, LT_SRC, DF_LOAD, LT_DATA, V_OUT],
  excludedWriters: [{ writer: DF_OTHER, table: LT_DATA }],
  ambiguousWriters: [],
  cycles: [],
};
const graph = {
  nodes: [V_OUT, DF_OTHER, LT_DATA, DF_LOAD, LT_SRC, LT_CONFIG],
  edges: [
    edge(LT_SRC, DF_LOAD, "reads_from"),
    edge(DF_LOAD, LT_DATA, "writes_to"),
    edge(DF_OTHER, LT_DATA, "writes_to"),
    edge(LT_DATA, V_OUT, "reads_from"),
    edge(LT_CONFIG, V_OUT, "reads_from"),
  ],
};

describe("lineage model", () => {
  const model = lineageModel(pipeline, graph);
  const node = (name: string) => model.nodes.find((n) => n.ref.technicalName === name)!;

  it("lists objects in pipeline order, excluded writers last", () => {
    expect(model.nodes.map((n) => n.ref.technicalName)).toEqual(["LT_CONFIG", "LT_SRC", "DF_LOAD", "LT_DATA", "V_OUT", "DF_OTHER"]);
  });

  it("marks the output, entry tables and excluded writers", () => {
    expect(node("V_OUT")).toMatchObject({ output: true, entry: false, excluded: false });
    expect(node("LT_SRC").entry).toBe(true);
    expect(node("DF_OTHER").excluded).toBe(true);
    expect(model.edges.filter((e) => e.excluded).map((e) => e.key)).toEqual(["S.DF_OTHER>S.LT_DATA>writes_to"]);
  });

  it("flags a table with several writers, its writers, and loops", () => {
    const ambiguous = lineageModel(
      { ...pipeline, excludedWriters: [], ambiguousWriters: [{ table: LT_DATA, writers: [DF_LOAD, DF_OTHER] }], cycles: [[LT_DATA, V_OUT]] },
      graph,
    );
    const flags = (name: string) => ambiguous.nodes.find((n) => n.ref.technicalName === name)!;
    expect(flags("LT_DATA")).toMatchObject({ severalWriters: true, inLoop: true });
    expect(flags("DF_OTHER")).toMatchObject({ competingWriter: true, excluded: false });
    expect(flags("LT_SRC")).toMatchObject({ severalWriters: false, competingWriter: false, inLoop: false });
  });

  it("names a writer by SPACE.NAME only when the pipeline spans several spaces", () => {
    expect(exclusionFor(DF_OTHER, pipeline)).toBe("DF_OTHER");
    expect(exclusionFor(DF_OTHER, { ...pipeline, steps: [...pipeline.steps, ref("V_SHARED", "sql_view", "SHARED")] })).toBe("S.DF_OTHER");
  });
});

describe("layout", () => {
  it("puts every object to the right of what it depends on", () => {
    const model = lineageModel(pipeline, graph);
    const at = layoutLeftToRight(
      model.nodes.map((n) => n.key),
      model.edges.map((e) => [e.from, e.to]),
    );
    expect(at.size).toBe(6);
    for (const e of model.edges) expect(at.get(e.from)!.x, e.key).toBeLessThan(at.get(e.to)!.x);
  });
});
