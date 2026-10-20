import { describe, expect, it, vi } from "vitest";
import { parseScenarioYaml } from "@ystara/shared";
import { buildPipeline } from "../discovery/graph.js";
import { graphFromRaw } from "../discovery/scan.js";
import { assertSelectOnly } from "../readonly.js";
import { SALES_SPACE } from "./fixtures/sales-space.js";
import { withPostgres } from "./postgres-testing.js";
import { compareRows, planScenario, runScenario, sameValue } from "./scenario.js";

const graph = graphFromRaw(SALES_SPACE, ["SALES"]);
const pipeline = buildPipeline(graph, { space: "SALES", technicalName: "V_REGION_OUT" });

const ORDERS = `
  - table: LT_ORDERS
    rows:
      - { ORDER_ID: "1", CUSTOMER_ID: C1, AMOUNT: 10.5, STATUS: OPEN }
      - { ORDER_ID: "2", CUSTOMER_ID: C1, AMOUNT: 4.5, STATUS: OPEN }
      - { ORDER_ID: "3", CUSTOMER_ID: C2, AMOUNT: 7, STATUS: CLOSED }
      - { ORDER_ID: "4", CUSTOMER_ID: C2, AMOUNT: 3, STATUS: OPEN }`;
const CUSTOMERS = `
  - table: SALES.LT_CUSTOMERS
    rows:
      - { CUSTOMER_ID: C1, REGION: NORTH }
      - { CUSTOMER_ID: C2, REGION: SOUTH }`;

const scenario = (fixtures: string, expect: string) =>
  parseScenarioYaml(`name: Region totals\nkind: golden\npipeline: SALES.V_REGION_OUT\nfixtures:${fixtures}\nexpect:${expect}\n`);

const run = (spec: ReturnType<typeof scenario>) => withPostgres((select) => runScenario(planScenario(graph, pipeline, spec), select));
const summary = (results: Awaited<ReturnType<typeof run>>) => results.map((r) => `${r.status} ${r.checkpoint} ${r.label}: ${r.detail}`);

describe("a scenario", () => {
  it("checks every assertion on what the pipeline's logic gives over its fixtures (run on PostgreSQL)", async () => {
    const spec = scenario(
      ORDERS + CUSTOMERS,
      `
  - checkpoint: V_REGION_OUT
    assertions:
      - { type: row_count, equals: 2 }
      - { type: unique, columns: [REGION] }
      - { type: no_nulls, columns: [REGION, TOTAL] }
      - { type: aggregate, column: TOTAL, fn: sum, equals: 18 }
      - type: rows_equal
        key: [REGION]
        rows: [{ REGION: NORTH, TOTAL: 15 }, { REGION: SOUTH, TOTAL: 3 }]
      - { type: sql, query: 'SELECT COUNT(*) FROM {{checkpoint}} AS c WHERE c."TOTAL" > 10', equals: 1 }
  - checkpoint: SALES.V_REGION_TOTALS
    assertions:
      - type: rows_equal
        key: [REGION]
        rows: [{ REGION: NORTH, SIZE: MANY }, { REGION: SOUTH, SIZE: ONE }]`,
    );
    const plan = planScenario(graph, pipeline, spec);
    expect(plan.problems).toEqual([]);
    for (const check of plan.checks) expect(() => assertSelectOnly(check.query!.sql)).not.toThrow();
    expect(summary(await run(spec))).toEqual([
      "pass V_REGION_OUT row_count = 2: 2 rows",
      "pass V_REGION_OUT unique REGION: every value appears once",
      "pass V_REGION_OUT no_nulls REGION, TOTAL: no empty values",
      "pass V_REGION_OUT sum(TOTAL) = 18: got 18",
      "pass V_REGION_OUT rows_equal on REGION (2 rows): the 2 rows expected",
      "pass V_REGION_OUT sql = 1: got 1",
      "pass SALES.V_REGION_TOTALS rows_equal on REGION (2 rows): the 2 rows expected",
    ]);
  });

  it("says what came back when an assertion fails", async () => {
    const spec = scenario(
      ORDERS + CUSTOMERS,
      `
  - checkpoint: V_REGION_OUT
    assertions:
      - { type: row_count, equals: 3 }
      - { type: aggregate, column: TOTAL, fn: max, equals: 20, tolerance: 1 }
      - type: rows_equal
        key: [REGION]
        rows: [{ REGION: SOUTH, TOTAL: 4 }, { REGION: EAST, TOTAL: 1 }]
      - { type: sql, query: 'SELECT "REGION" FROM {{checkpoint}} AS c', equals: NORTH }`,
    );
    expect(summary(await run(spec))).toEqual([
      "fail V_REGION_OUT row_count = 3: 2 rows, 3 expected",
      "fail V_REGION_OUT max(TOTAL) = 20 ± 1: got 15",
      'fail V_REGION_OUT rows_equal on REGION (2 rows): 1 missing: REGION "EAST". 1 different: REGION "SOUTH": TOTAL "3.00", 4 expected. 1 not expected: REGION "NORTH"',
      "fail V_REGION_OUT sql = \"NORTH\": returned 2 rows and 1 column; one of each expected",
    ]);
  });

  it("leaves a table it gives no rows for empty, and lets given rows stand in for the flow that loads a table", async () => {
    const empty = scenario(ORDERS, "\n  - checkpoint: V_REGION_OUT\n    assertions: [{ type: row_count, equals: 0 }]");
    const plan = planScenario(graph, pipeline, empty);
    expect(plan.simulation.steps.find((s) => s.ref.technicalName === "LT_CUSTOMERS")!.note).toBe(
      "empty, because no rows are given for it (nothing in the pipeline loads it)",
    );
    expect(summary(await run(empty))).toEqual(["pass V_REGION_OUT row_count = 0: 0 rows"]);

    const midway = scenario(
      "\n  - table: LT_REGION_TOTALS\n    rows: [{ REGION: WEST, TOTAL: 2.5 }]",
      "\n  - checkpoint: V_REGION_OUT\n    assertions: [{ type: rows_equal, key: [REGION], rows: [{ REGION: WEST, TOTAL: 2.5 }] }]",
    );
    expect(planScenario(graph, pipeline, midway).simulation.steps.find((s) => s.ref.technicalName === "LT_REGION_TOTALS")!.note).toBe(
      "fixture with 1 given row, in place of TF_REGION_LOAD, which loads it",
    );
    expect(summary(await run(midway))).toEqual(["pass V_REGION_OUT rows_equal on REGION (1 row): the 1 row expected"]);
  });

  it("sends nothing while a fixture or a checkpoint can't be placed, and says why", async () => {
    const spec = scenario(
      ORDERS +
        `
  - table: LT_NOPE
    rows: []
  - table: V_OPEN_ORDERS
    rows: []
  - table: LT_CUSTOMERS
    csv: customers.csv
  - table: LT_REGION_TOTALS
    rows: [{ REGION: WEST, COLOUR: red }]`,
      `
  - checkpoint: V_NOPE
    assertions: [{ type: row_count, equals: 0 }]
  - checkpoint: DF_ORDERS
    assertions: [{ type: row_count, equals: 0 }]`,
    );
    const plan = planScenario(graph, pipeline, spec);
    expect(plan.problems).toEqual([
      "The fixture for LT_NOPE names no table of the pipeline.",
      "V_OPEN_ORDERS is a sql view: fixtures stand in for tables, so give rows to the tables it reads.",
      "The fixture for LT_CUSTOMERS reads a CSV file, which isn't supported yet: give its rows in the scenario.",
      "The fixture for LT_REGION_TOTALS has columns the table doesn't have: COLOUR.",
    ]);
    expect(plan.checks.map((c) => c.problem)).toEqual([
      "V_NOPE isn't a step of the pipeline.",
      "DF_ORDERS is a data flow, which holds no rows: check the table it loads.",
    ]);
    const select = vi.fn();
    const results = await runScenario(plan, select);
    expect(select).not.toHaveBeenCalled();
    expect(results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
  });

  it("runs an sql assertion only as one SELECT over its checkpoint, never over a real object", () => {
    const check = (query: string) =>
      planScenario(graph, pipeline, scenario(ORDERS, `\n  - checkpoint: V_REGION_OUT\n    assertions: [{ type: sql, query: '${query}', equals: 0 }]`)).checks[0].problem;
    expect(check('SELECT COUNT(*) FROM {{checkpoint}} AS c JOIN "LT_ORDERS" o ON 1 = 1')).toBe("the compiled SQL would read LT_ORDERS itself, so it is not sent");
    expect(check("SELECT COUNT(*) FROM DUMMY")).toBe("its query doesn't read {{checkpoint}}");
    expect(check("SELECT COUNT(*) FROM {{checkpoint}} AS c WHERE 1 = ?")).toBe("its query has ? placeholders");
    expect(check("SELECT 1 FROM {{checkpoint}} AS c; DELETE FROM X")).toMatch(/^its query isn't a single SELECT/);
  });

  it("replaces only the placeholder in the SQL of an sql assertion, not one in a string", async () => {
    const spec = scenario(
      ORDERS + CUSTOMERS,
      `\n  - checkpoint: V_REGION_OUT\n    assertions: [{ type: sql, query: "SELECT COUNT(*) FROM {{checkpoint}} AS c WHERE c.\\"REGION\\" <> '{{checkpoint}}'", equals: 2 }]`,
    );
    expect(summary(await run(spec))).toEqual(["pass V_REGION_OUT sql = 2: got 2"]);
  });
});

describe("comparing values", () => {
  it("compares a number written as a number as a number, and quoted text as text", () => {
    expect(sameValue(15, "15.00")).toBe(true);
    expect(sameValue(15, 15n)).toBe(true);
    expect(sameValue("15", 15)).toBe(true);
    expect(sameValue("007", "7")).toBe(false);
    expect(sameValue("2026-01-15T10:00:00", "2026-01-15 10:00:00.000000000")).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "")).toBe(false);
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    // Other drivers than hdb give dates as Dates in local time.
    expect(sameValue("2026-01-15", new Date(2026, 0, 15))).toBe(true);
    expect(sameValue("2026-01-15 10:30:00", new Date(2026, 0, 15, 10, 30))).toBe(true);
  });

  it("finds rows that are missing, repeated, different or not expected", () => {
    const actual = [
      { ID: 1, NAME: "A", EXTRA: "ignored" },
      { ID: 2, NAME: "B" },
      { ID: 2, NAME: "B" },
      { ID: 4, NAME: "D" },
    ];
    expect(compareRows(["ID"], [{ ID: 1, NAME: "A" }], [{ ID: 1, NAME: "A", EXTRA: "x" }])).toEqual({ pass: true, detail: "the 1 row expected" });
    expect(compareRows(["ID"], [{ ID: 1, NAME: "Z" }, { ID: 2 }, { ID: 3 }], actual).detail).toBe(
      "1 missing: ID 3. 1 more than once: ID 2 (2 times). 1 different: ID 1: NAME \"A\", \"Z\" expected. 1 not expected: ID 4",
    );
    expect(compareRows(["ID"], [{ NAME: "A" }], actual).detail).toBe("expected row 1 has no ID");
    expect(compareRows(["ID"], [{ ID: 1 }, { ID: 1 }], [{ ID: 1 }]).detail).toBe("expected row 2 has the same ID as an earlier one");
    expect(compareRows(["ID"], [{ ID: 1, COLOUR: "red" }], actual).detail).toBe("the result has no column COLOUR");
  });
});
