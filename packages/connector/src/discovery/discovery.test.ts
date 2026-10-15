import { describe, expect, it } from "vitest";
import { refKey } from "@ystara/shared";
import { HR_SPACE } from "./fixtures/hr-space.js";
import { buildPipeline } from "./graph.js";
import { toMermaid } from "./mermaid.js";
import { graphFromRaw, readSpaces } from "./scan.js";
import type { ObjectSource } from "../types.js";

const graph = graphFromRaw(HR_SPACE, ["HR"]);
const edge = (from: string, to: string, kind: string) =>
  graph.edges.some((e) => e.from.technicalName === from && e.to.technicalName === to && e.kind === kind);

describe("lineage graph", () => {
  it("links every step of the SuccessFactors-to-CPI chain in the direction data moves", () => {
    expect(edge("DF_SF_EMPLOYEE", "LT_EMPLOYEE_RAW", "writes_to")).toBe(true);
    expect(edge("LT_EMPLOYEE_RAW", "V_EMPLOYEE_CLEAN", "reads_from")).toBe(true);
    expect(edge("V_EMPLOYEE_CLEAN", "TF_EMPLOYEE_ENRICH", "reads_from")).toBe(true);
    expect(edge("TF_EMPLOYEE_ENRICH", "LT_EMPLOYEE_ENRICHED", "writes_to")).toBe(true);
    expect(edge("LT_EMPLOYEE_ENRICHED", "TF_HEADCOUNT", "reads_from")).toBe(true);
    expect(edge("TF_HEADCOUNT", "LT_HEADCOUNT", "writes_to")).toBe(true);
    expect(edge("LT_HEADCOUNT", "V_HEADCOUNT_OUT", "reads_from")).toBe(true);
    expect(edge("LT_ORG_DIM", "V_HEADCOUNT_OUT", "reads_from")).toBe(true);
  });

  it("records task chain steps as control edges, not data edges", () => {
    expect(edge("TC_HR_DAILY", "DF_SF_EMPLOYEE", "triggers")).toBe(true);
    expect(edge("TC_HR_DAILY", "TF_HEADCOUNT", "triggers")).toBe(true);
  });

  it("ignores dependency definitions bundled into a read", () => {
    expect(edge("DF_SF_EMPLOYEE", "V_EMPLOYEE_CLEAN", "reads_from")).toBe(false);
  });

  it("splits SQL and graphical views", () => {
    expect(graph.nodes.find((n) => n.technicalName === "V_HEADCOUNT_OUT")?.type).toBe("sql_view");
  });
});

describe("pipeline", () => {
  const p = buildPipeline(graph, { space: "HR", technicalName: "V_HEADCOUNT_OUT" });
  const names = p.steps.map((s) => s.technicalName);

  it("contains the whole upstream chain and nothing unrelated", () => {
    expect(names).toHaveLength(9);
    expect(names).not.toContain("V_UNRELATED");
    expect(names).not.toContain("TC_HR_DAILY");
    expect(names.at(-1)).toBe("V_HEADCOUNT_OUT");
  });

  it("orders every step after the steps it depends on", () => {
    for (const e of graph.edges.filter((e) => e.kind !== "triggers")) {
      const a = names.indexOf(e.from.technicalName);
      const b = names.indexOf(e.to.technicalName);
      if (a >= 0 && b >= 0) expect(a).toBeLessThan(b);
    }
  });

  it("finds the entry tables where fixtures go", () => {
    expect(p.entryPoints.map((e) => e.technicalName).sort()).toEqual(["LT_EMPLOYEE_RAW", "LT_ORG_DIM"]);
  });

  it("lists the task chain that runs the flows", () => {
    expect(p.orchestrators.map(refKey)).toEqual(["HR.TC_HR_DAILY"]);
  });

  it("renders a Mermaid diagram with entry and output highlighted", () => {
    const m = toMermaid(graph, p);
    expect(m.startsWith("flowchart LR")).toBe(true);
    expect(m).toContain("==>|writes|");
    expect(m).toContain("class n_HR_V_HEADCOUNT_OUT output");
    expect(m).not.toContain("V_UNRELATED");
  });

  it("explains a missing output object", () => {
    expect(() => buildPipeline(graph, { space: "HR", technicalName: "NOPE" })).toThrow(/not found/);
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
