import { describe, expect, it } from "vitest";
import type { DspObject, LineageGraph, ObjectType } from "@ystara/shared";
import { changedSteps } from "./changes.js";

/** A synthetic graph: each object as NAME:hash, each edge as "FROM>TO" (reads_from: data moves from FROM to TO). */
function graph(objects: Record<string, [ObjectType, string]>, edges: string[]): LineageGraph {
  const nodes: DspObject[] = Object.entries(objects).map(([technicalName, [type, hash]]) => ({ space: "S", technicalName, type, definition: null, definitionHash: hash }));
  const ref = (name: string) => ({ space: "S", technicalName: name, type: objects[name]![0] });
  return {
    scannedAt: "2026-10-21T00:00:00.000Z",
    spaces: ["S"],
    nodes,
    edges: edges.map((e) => {
      const [from, to] = e.split(">") as [string, string];
      return { from: ref(from), to: ref(to), kind: "reads_from" as const };
    }),
    warnings: [],
  };
}

const pipeline = { output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] };

describe("changed steps", () => {
  const before = graph({ LT_A: ["local_table", "a1"], V_OUT: ["sql_view", "o1"], V_OTHER: ["sql_view", "x1"] }, ["LT_A>V_OUT", "LT_A>V_OTHER"]);

  it("are none when the pipeline's definitions are the same, whatever else changed", () => {
    const after = graph({ LT_A: ["local_table", "a1"], V_OUT: ["sql_view", "o1"], V_OTHER: ["sql_view", "x2"] }, ["LT_A>V_OUT", "LT_A>V_OTHER"]);
    expect(changedSteps(before, after, pipeline)).toEqual([]);
  });

  it("name each step with another definition, and steps that came or went", () => {
    const after = graph({ LT_A: ["local_table", "a1"], LT_B: ["local_table", "b1"], V_MID: ["sql_view", "m1"], V_OUT: ["sql_view", "o2"] }, [
      "LT_B>V_MID",
      "V_MID>V_OUT",
    ]);
    expect(changedSteps(before, after, pipeline)).toEqual([
      { space: "S", technicalName: "LT_B", type: "local_table", change: "added" },
      { space: "S", technicalName: "V_MID", type: "sql_view", change: "added" },
      { space: "S", technicalName: "V_OUT", type: "sql_view", change: "definition" },
      { space: "S", technicalName: "LT_A", type: "local_table", change: "removed" },
    ]);
  });

  it("count every step as added without a scan to compare with, and as removed when the output is gone", () => {
    expect(changedSteps(undefined, before, pipeline).map((s) => [s.technicalName, s.change])).toEqual([
      ["LT_A", "added"],
      ["V_OUT", "added"],
    ]);
    expect(changedSteps(before, graph({ LT_A: ["local_table", "a1"] }, []), pipeline).map((s) => [s.technicalName, s.change])).toEqual([
      ["LT_A", "removed"],
      ["V_OUT", "removed"],
    ]);
    expect(changedSteps(undefined, graph({ LT_A: ["local_table", "a1"] }, []), pipeline)).toEqual([]);
  });
});
