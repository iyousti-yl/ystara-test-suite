import { describe, expect, it } from "vitest";
import { refKey } from "@ystara/shared";
import { HR_SPACE } from "./fixtures/hr-space.js";
import { buildPipeline, pipelineGraph } from "./graph.js";
import { toMermaid } from "./mermaid.js";
import { graphFromRaw, readSpaces, type RawObject } from "./scan.js";
import type { ObjectSource } from "../types.js";

const graph = graphFromRaw(HR_SPACE, ["HR"]);
const edge = (from: string, to: string, kind: string) =>
  graph.edges.some((e) => e.from.technicalName === from && e.to.technicalName === to && e.kind === kind);
const linked = (a: string, b: string) =>
  graph.edges.some((e) => (e.from.technicalName === a && e.to.technicalName === b) || (e.from.technicalName === b && e.to.technicalName === a));
const OUTPUT = { space: "HR", technicalName: "V_HEADCOUNT_OUT" };

describe("lineage graph", () => {
  it("links the main chain in the direction data moves", () => {
    expect(edge("DF_SF_EMPLOYEE", "LT_EMPLOYEE_RAW", "writes_to")).toBe(true);
    expect(edge("LT_EMPLOYEE_RAW", "V_EMPLOYEE_CLEAN", "reads_from")).toBe(true);
    expect(edge("V_EMPLOYEE_CLEAN", "TF_EMPLOYEE_ENRICH", "reads_from")).toBe(true);
    expect(edge("TF_EMPLOYEE_ENRICH", "LT_EMPLOYEE_ENRICHED", "writes_to")).toBe(true);
    expect(edge("LT_EMPLOYEE_ENRICHED", "TF_HEADCOUNT", "reads_from")).toBe(true);
    expect(edge("TF_HEADCOUNT", "LT_HEADCOUNT", "writes_to")).toBe(true);
    expect(edge("LT_HEADCOUNT", "V_HEADCOUNT_OUT", "reads_from")).toBe(true);
    expect(edge("LT_ORG_DIM", "V_HEADCOUNT_OUT", "reads_from")).toBe(true);
  });

  it("takes a data flow's write from the step's component, whatever the step is called", () => {
    // The write step is "producer1"; the table must not come out as something the flow reads.
    expect(edge("LT_EMPLOYEE_RAW", "DF_SF_EMPLOYEE", "reads_from")).toBe(false);
    expect(edge("DF_SF_ORG", "LT_ORG_RAW", "writes_to")).toBe(true);
  });

  it("takes a data flow's write from its targets section", () => {
    expect(edge("DF_EMPLOYEE_BACKFILL", "LT_EMPLOYEE_RAW", "writes_to")).toBe(true);
    expect(edge("LT_EMPLOYEE_ARCHIVE", "DF_EMPLOYEE_BACKFILL", "reads_from")).toBe(true);
  });

  it("takes a transformation flow's write from its com.sap.dwc.target step", () => {
    expect(edge("TF_HEADCOUNT", "LT_HEADCOUNT", "writes_to")).toBe(true);
    expect(edge("LT_EMPLOYEE_ENRICHED", "TF_EMPLOYEE_ENRICH", "reads_from")).toBe(false);
  });

  it("ignores names that appear only in SQL comments", () => {
    expect(linked("LT_LEGACY_ORG", "TF_EMPLOYEE_ENRICH")).toBe(false);
    expect(linked("V_UNRELATED", "V_HEADCOUNT_OUT")).toBe(false);
  });

  it("does not count a flow reading its own target as a dependency", () => {
    expect(edge("LT_HEADCOUNT", "TF_HEADCOUNT", "reads_from")).toBe(false);
  });

  it("links side inputs: config tables and control views", () => {
    expect(edge("LT_HR_CONFIG", "TF_HEADCOUNT", "reads_from")).toBe(true);
    expect(edge("V_ACTIVE_ORG_FILTER", "V_EMPLOYEE_CLEAN", "reads_from")).toBe(true);
    expect(edge("LT_ORG_FILTER", "V_ACTIVE_ORG_FILTER", "reads_from")).toBe(true);
    expect(edge("LT_ORG_RAW", "V_ACTIVE_ORG_FILTER", "reads_from")).toBe(true);
  });

  it("records task chain steps as control edges, not data edges", () => {
    expect(edge("TC_HR_DAILY", "DF_SF_EMPLOYEE", "triggers")).toBe(true);
    expect(edge("TC_HR_DAILY", "LT_EMPLOYEE_ENRICHED", "triggers")).toBe(true);
    expect(graph.edges.filter((e) => e.from.technicalName === "TC_HR_DAILY").every((e) => e.kind === "triggers")).toBe(true);
  });

  it("ignores dependency definitions bundled into a read", () => {
    expect(edge("DF_SF_EMPLOYEE", "V_EMPLOYEE_CLEAN", "reads_from")).toBe(false);
  });

  it("splits SQL and graphical views", () => {
    expect(graph.nodes.find((n) => n.technicalName === "V_HEADCOUNT_OUT")?.type).toBe("sql_view");
    expect(graph.nodes.find((n) => n.technicalName === "V_ACTIVE_ORG_FILTER")?.type).toBe("graphical_view");
  });
});

describe("pipeline with the other writer excluded", () => {
  const p = buildPipeline(graph, OUTPUT, { excludeWriters: ["DF_EMPLOYEE_BACKFILL"] });
  const names = p.steps.map((s) => s.technicalName);

  it("holds the main chain and side inputs, and nothing else", () => {
    expect([...names].sort()).toEqual([
      "DF_SF_EMPLOYEE",
      "DF_SF_ORG",
      "LT_EMPLOYEE_ENRICHED",
      "LT_EMPLOYEE_RAW",
      "LT_HEADCOUNT",
      "LT_HR_CONFIG",
      "LT_ORG_DIM",
      "LT_ORG_FILTER",
      "LT_ORG_RAW",
      "TF_EMPLOYEE_ENRICH",
      "TF_HEADCOUNT",
      "V_ACTIVE_ORG_FILTER",
      "V_EMPLOYEE_CLEAN",
      "V_HEADCOUNT_OUT",
    ]);
  });

  it("lists the excluded writer without following it", () => {
    expect(p.excludedWriters.map((x) => `${x.writer.technicalName} -> ${x.table.technicalName}`)).toEqual(["DF_EMPLOYEE_BACKFILL -> LT_EMPLOYEE_RAW"]);
    expect(names).not.toContain("DF_EMPLOYEE_BACKFILL");
    expect(names).not.toContain("LT_EMPLOYEE_ARCHIVE");
    expect(p.ambiguousWriters).toEqual([]);
  });

  it("leaves out task chains and comment-only references", () => {
    expect(names).not.toContain("TC_HR_DAILY");
    expect(names).not.toContain("LT_LEGACY_ORG");
    expect(names).not.toContain("DF_LEGACY_ORG");
    expect(names).not.toContain("V_UNRELATED");
    expect(p).not.toHaveProperty("orchestrators");
  });

  it("orders every step after the steps it depends on, output last, no cycles", () => {
    expect(p.cycles).toEqual([]);
    expect(names.at(-1)).toBe("V_HEADCOUNT_OUT");
    for (const e of graph.edges.filter((e) => e.kind !== "triggers")) {
      const a = names.indexOf(e.from.technicalName);
      const b = names.indexOf(e.to.technicalName);
      if (a >= 0 && b >= 0) expect(a).toBeLessThan(b);
    }
  });

  it("finds the entry tables where fixtures go: ingestion tables and unwritten side inputs", () => {
    expect(p.entryPoints.map((e) => e.technicalName).sort()).toEqual(["LT_EMPLOYEE_RAW", "LT_HR_CONFIG", "LT_ORG_DIM", "LT_ORG_FILTER", "LT_ORG_RAW"]);
  });

  it("accepts wildcards and SPACE.NAME in exclusions, ignoring case", () => {
    for (const pattern of ["df_*backfill", "HR.DF_EMPLOYEE_BACKFILL", "*_BACKFIL?"]) {
      const q = buildPipeline(graph, OUTPUT, { excludeWriters: [pattern] });
      expect(q.steps.map(refKey)).toEqual(p.steps.map(refKey));
    }
  });

  it("gives the web app the steps, the excluded writer and the data edges between them to draw", () => {
    const g = pipelineGraph(graph, p);
    expect(g.nodes.map((n) => n.technicalName).sort()).toEqual([...names, "DF_EMPLOYEE_BACKFILL"].sort());
    expect(g.nodes.find((n) => n.technicalName === "LT_HEADCOUNT")).not.toHaveProperty("definition");
    const drawn = g.edges.map((e) => `${e.from.technicalName} ${e.kind} ${e.to.technicalName}`);
    expect(drawn).toContain("DF_EMPLOYEE_BACKFILL writes_to LT_EMPLOYEE_RAW");
    expect(drawn).toContain("LT_EMPLOYEE_RAW reads_from V_EMPLOYEE_CLEAN");
    expect(drawn.filter((d) => d.includes("DF_EMPLOYEE_BACKFILL"))).toEqual(["DF_EMPLOYEE_BACKFILL writes_to LT_EMPLOYEE_RAW"]);
    expect(g.edges.every((e) => e.kind !== "triggers")).toBe(true);
  });

  it("renders a Mermaid diagram with only the pipeline's steps", () => {
    const m = toMermaid(graph, p);
    expect(m.startsWith("flowchart LR")).toBe(true);
    expect(m).toContain("==>|writes|");
    expect(m).toContain("class n_HR_V_HEADCOUNT_OUT output");
    for (const absent of ["V_UNRELATED", "TC_HR_DAILY", "DF_EMPLOYEE_BACKFILL", "LT_LEGACY_ORG", "|runs|"]) expect(m).not.toContain(absent);
  });
});

describe("pipeline without exclusions", () => {
  const p = buildPipeline(graph, OUTPUT);
  const names = p.steps.map((s) => s.technicalName);

  it("flags a table with several writers instead of picking one", () => {
    expect(p.ambiguousWriters.map((a) => [a.table.technicalName, a.writers.map((w) => w.technicalName)])).toEqual([
      ["LT_EMPLOYEE_RAW", ["DF_EMPLOYEE_BACKFILL", "DF_SF_EMPLOYEE"]],
    ]);
    expect(p.excludedWriters).toEqual([]);
  });

  it("follows every writer of an ambiguous table, so nothing is silently dropped", () => {
    expect(names).toContain("DF_EMPLOYEE_BACKFILL");
    expect(names).toContain("LT_EMPLOYEE_ARCHIVE");
    expect(names).toHaveLength(16);
  });

  it("explains a missing output object", () => {
    expect(() => buildPipeline(graph, { space: "HR", technicalName: "NOPE" })).toThrow(/not found/);
  });
});

describe("step order with a loop", () => {
  const view = (name: string, from: string[]): RawObject => ({
    space: "S",
    kind: "views",
    technicalName: name,
    definition: { definitions: { [name]: { kind: "entity", "@DataWarehouse.sqlEditor.query": `SELECT * FROM ${from.map((f) => `"${f}"`).join(", ")}` } } },
  });
  const raw: RawObject[] = [
    { space: "S", kind: "local-tables", technicalName: "T_BASE", definition: { definitions: { T_BASE: { kind: "entity" } } } },
    view("V_A", ["V_B", "T_BASE"]),
    view("V_B", ["V_A"]),
    view("V_OUT", ["V_A"]),
  ];
  const p = buildPipeline(graphFromRaw(raw, ["S"]), { space: "S", technicalName: "V_OUT" });

  it("reports the loop instead of hiding it", () => {
    expect(p.cycles.map((c) => c.map((s) => s.technicalName))).toEqual([["V_A", "V_B"]]);
  });

  it("still places the loop between what it depends on and what depends on it", () => {
    expect(p.steps.map((s) => s.technicalName)).toEqual(["T_BASE", "V_A", "V_B", "V_OUT"]);
  });
});

describe("readSpaces", () => {
  it("only lists and reads, and turns one failing object into a warning", async () => {
    const calls: string[] = [];
    const source: ObjectSource = {
      async listObjects(space, kind) {
        calls.push(`list ${kind}`);
        return HR_SPACE.filter((o) => o.space === space && o.kind === kind).map((o) => ({ technicalName: o.technicalName }));
      },
      async readObject(space, kind, name) {
        calls.push(`read ${name}`);
        if (name === "V_UNRELATED") throw new Error("403 Forbidden");
        return HR_SPACE.find((o) => o.technicalName === name)!.definition;
      },
    };
    const { raw, warnings } = await readSpaces(source, ["HR"]);
    expect(raw).toHaveLength(HR_SPACE.length - 1);
    expect(warnings).toEqual([expect.stringContaining("V_UNRELATED")]);
    expect(calls.every((c) => c.startsWith("list ") || c.startsWith("read "))).toBe(true);
  });
});

describe("scan warnings", () => {
  it("keep the CLI's own error line, not the command or its warnings", async () => {
    const failing: ObjectSource = {
      async listObjects() {
        throw Object.assign(new Error("Command failed with exit code 1: datasphere objects views list"), {
          stderr: "WARNING: some config notice\nerror: unknown command 'objects'\n\nMake sure to define the host.",
        });
      },
      async readObject() {
        return {};
      },
    };
    const { warnings } = await readSpaces(failing, ["HR"]);
    expect(warnings[0]).toBe("HR: could not list remote-tables: error: unknown command 'objects'");
  });
});
