import { describe, expect, it } from "vitest";
import { parseScenarioYaml } from "@ystara/shared";
import { buildPipeline } from "../discovery/graph.js";
import { graphFromRaw } from "../discovery/scan.js";
import { SALES_SPACE } from "./fixtures/sales-space.js";
import { planScenario } from "./scenario.js";
import { stepLogic } from "./simulate.js";
import { scenarioSkeleton } from "./skeleton.js";

const graph = graphFromRaw(SALES_SPACE, ["SALES"]);
const pipeline = buildPipeline(graph, { space: "SALES", technicalName: "V_REGION_OUT" });
const node = (name: string) => graph.nodes.find((n) => n.technicalName === name)!;

describe("a scenario skeleton", () => {
  const yaml = scenarioSkeleton(graph, pipeline, { from: "tools/scan/output/run", file: "tools/scenario/region.local.yaml" });

  it("lists every table that takes rows, with all its columns null and their types, and why it takes rows", () => {
    expect(yaml).toContain(
      [
        "fixtures:",
        "  # LT_CUSTOMERS: nothing in the pipeline loads it",
        "  - table: SALES.LT_CUSTOMERS",
        "    rows:",
        "      - CUSTOMER_ID: null  # NVARCHAR(10)",
        "        REGION: null       # NVARCHAR(20)",
        "  # LT_ORDERS: DF_ORDERS loads it, and a data flow can't be expressed in SQL",
        "  - table: SALES.LT_ORDERS",
      ].join("\n"),
    );
    // LT_REGION_TOTALS is its flow's SELECT, so it takes no rows; it can still be checked.
    expect(yaml).not.toContain("- table: SALES.LT_REGION_TOTALS");
    expect(yaml).toContain("#   SALES.LT_REGION_TOTALS\n");
    expect(yaml).not.toContain("#   SALES.DF_ORDERS");
  });

  it("parses as a scenario and compiles as it is", () => {
    const plan = planScenario(graph, pipeline, parseScenarioYaml(yaml));
    expect(plan.problems).toEqual([]);
    expect(plan.checks.map((c) => [c.checkpoint, c.label, c.problem])).toEqual([["SALES.V_REGION_OUT", "row_count = 1", undefined]]);
  });

  it("quotes a name YAML would read as something else", () => {
    const odd = SALES_SPACE.map((o) =>
      o.technicalName === "LT_CUSTOMERS"
        ? { ...o, definition: { definitions: { LT_CUSTOMERS: { kind: "entity", elements: { "/BIC/KEY": { type: "cds.String", length: 10 }, null: { type: "cds.Integer" } } } } } }
        : o,
    );
    const text = scenarioSkeleton(graphFromRaw(odd, ["SALES"]), pipeline);
    expect(text).toContain('      - "/BIC/KEY": null  # NVARCHAR(10)\n        "null": null      # INTEGER');
    expect(parseScenarioYaml(text).fixtures[0].rows).toEqual([{ "/BIC/KEY": null, null: null }]);
  });
});

describe("a step's logic", () => {
  it("is the SQL of SQL views and transformation flows, and the CSN query of graphical views", () => {
    expect(stepLogic(node("V_OPEN_ORDERS"))).toMatchObject({ language: "sql", text: expect.stringContaining(`WHERE o."STATUS" = 'OPEN'`) });
    expect(stepLogic(node("TF_REGION_LOAD"))).toMatchObject({ language: "sql", text: expect.stringContaining("WHERE NOT EXISTS") });
    const csn = stepLogic(node("V_REGION_TOTALS"))!;
    expect(csn.language).toBe("csn");
    expect(csn.text).toContain('"groupBy": [{"ref":["c","REGION"]}]');
    expect(stepLogic(node("LT_ORDERS"))).toBeUndefined();
    expect(stepLogic(node("DF_ORDERS"))).toBeUndefined();
  });
});
