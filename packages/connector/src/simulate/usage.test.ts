import { describe, expect, it } from "vitest";
import { buildPipeline } from "../discovery/graph.js";
import { graphFromRaw } from "../discovery/scan.js";
import { SALES_SPACE } from "./fixtures/sales-space.js";
import { scenarioInputs } from "./skeleton.js";
import { columnUsage, stepColumnUsage } from "./usage.js";

const sql = (text: string) => stepColumnUsage({ sql: text });

describe("which columns a pipeline uses", () => {
  const graph = graphFromRaw(SALES_SPACE, ["SALES"]);
  const pipeline = buildPipeline(graph, { space: "SALES", technicalName: "V_REGION_OUT" });

  it("marks the columns its filters, joins, groupings and sums read, and not those only passed on", () => {
    const usage = columnUsage(graph, pipeline);
    expect([...usage.used].sort()).toEqual(expect.arrayContaining(["AMOUNT", "CUSTOMER_ID", "REGION", "STATUS"]));
    expect(usage.used.has("ORDER_ID")).toBe(false);
    expect([...usage.joined].sort()).toEqual(["CUSTOMER_ID", "REGION"]);
    expect(usage.keeps.get("STATUS")).toBe("OPEN");
  });

  it("annotates the columns of the tables that take rows", () => {
    const orders = scenarioInputs(graph, pipeline).tables.find((t) => t.technicalName === "LT_ORDERS")!;
    expect(orders.columns).toEqual([
      { name: "ORDER_ID", type: "NVARCHAR(10)" },
      { name: "CUSTOMER_ID", type: "NVARCHAR(10)", used: true, joined: true },
      { name: "AMOUNT", type: "DECIMAL(15, 2)", used: true },
      { name: "STATUS", type: "NVARCHAR(10)", used: true, keeps: "OPEN" },
    ]);
  });
});

describe("one step's SQL", () => {
  it("passes what is said of a new name back to the column it renames, over several steps", () => {
    const usage = columnUsage(
      graphFromRaw(
        [
          { space: "S", kind: "local-tables", technicalName: "LT_RAW", definition: { definitions: { LT_RAW: { kind: "entity", elements: { EMP_ID: { type: "cds.String", length: 8, key: true }, STAT: { type: "cds.String", length: 1 } } } } } },
          view("V_ONE", 'SELECT "EMP_ID" AS "employeeId", STAT status FROM LT_RAW'),
          view("V_TWO", 'SELECT * FROM V_ONE WHERE "status" = \'A\''),
          view("V_OUT", 'SELECT "employeeId" AS "id" FROM V_TWO WHERE "id" IS NOT NULL GROUP BY "employeeId"'),
        ],
        ["S"],
      ),
      { output: { space: "S", technicalName: "V_OUT" }, steps: ["LT_RAW", "V_ONE", "V_TWO", "V_OUT"].map((n) => ({ space: "S", technicalName: n, type: n.startsWith("LT") ? "local_table" : "sql_view" })), entryPoints: [], excludedWriters: [] } as never,
    );
    expect(usage.used.has("EMP_ID")).toBe(true);
    // STAT is unquoted, so status is STATUS in SAP HANA, not the quoted "status" V_TWO filters on.
    expect(usage.keeps.has("STAT")).toBe(false);
  });

  it("reads the values its filters keep", () => {
    const usage = sql(`SELECT a.X FROM T a
      WHERE a."KIND" IN ('P', 'Q') AND 'EUR' = "CURRENCY" AND "CODE" LIKE 'AB_%' AND "LEVEL" BETWEEN 2 AND 4 AND "DELETED" IS NULL
        AND "AMOUNT" = -1.5 AND "DAY" = DATE '2026-02-01' AND "OTHER" <> 'Z'`);
    expect(Object.fromEntries(usage.keeps)).toEqual({ KIND: "P", CURRENCY: "EUR", CODE: "ABX", LEVEL: 2, DELETED: null, AMOUNT: -1.5, DAY: "2026-02-01" });
    expect(usage.used.has("OTHER")).toBe(true);
    expect(usage.keeps.has("OTHER")).toBe(false);
  });

  it("reads validity ranges compared with today", () => {
    const usage = sql(`SELECT * FROM T WHERE "START_DATE" <= CURRENT_DATE AND CURRENT_DATE <= "END_DATE"
      AND NOW() BETWEEN "VALID_FROM" AND "VALID_TO" AND "SEEN" > NOW()`);
    expect(Object.fromEntries(usage.range)).toEqual({ START_DATE: "start", END_DATE: "end", VALID_FROM: "start", VALID_TO: "end", SEEN: "end" });
  });

  it("marks both sides of a join, inside a join group and a subquery too", () => {
    const usage = sql(`SELECT a."A" FROM (T1 a JOIN T2 b ON a."K1" = b."K2") LEFT JOIN T3 c ON c."K3" = a."A"
      WHERE EXISTS (SELECT 1 FROM T4 d WHERE d."K4" = a."K1")`);
    expect([...usage.joined].sort()).toEqual(["A", "K1", "K2", "K3", "K4"]);
  });

  it("reads every name of a calculation, but not functions, casts, qualifiers or aliases", () => {
    const usage = sql(`SELECT DISTINCT TOP 10 "PLAIN", COALESCE(t."A", 0) + CAST("B" AS DECIMAL(15, 2)) AS "SUM", CASE WHEN "C" = 'Y' THEN 1 END flag,
      (SELECT MAX("D") FROM T2) "MAXD", EXTRACT(YEAR FROM "E") yr FROM T t`);
    expect([...usage.used].sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(usage.keeps.get("C")).toBe("Y");
  });
});

describe("a graphical view's CSN query", () => {
  it("reads joins, filters, groupings and calculations, and passes renames back", () => {
    const usage = stepColumnUsage({
      csn: {
        SELECT: {
          from: { join: "left", args: [{ ref: ["A"], as: "a" }, { ref: ["B"], as: "b" }], on: [{ ref: ["a", "K"] }, "=", { ref: ["b", "K2"] }] },
          columns: [{ ref: ["a", "PLAIN"] }, { ref: ["a", "OLD"], as: "NEW" }, { func: "sum", args: [{ ref: ["b", "AMT"] }], as: "TOTAL" }],
          where: [
            { ref: ["a", "STATUS"] }, "in", { list: [{ val: "OPEN" }, { val: "HELD" }] },
            "and", { xpr: [{ ref: ["a", "VALID_TO"] }, ">=", { func: "current_date" }] },
            "and", { ref: ["NEW"] }, "=", { val: 3 },
          ],
          groupBy: [{ ref: ["a", "GRP"] }],
        },
      },
    });
    expect([...usage.used].sort()).toEqual(["AMT", "GRP", "K", "K2", "NEW", "OLD", "STATUS", "VALID_TO"]);
    expect([...usage.joined].sort()).toEqual(["K", "K2"]);
    expect(Object.fromEntries(usage.keeps)).toEqual({ STATUS: "OPEN", NEW: 3, OLD: 3 });
    expect(Object.fromEntries(usage.range)).toEqual({ VALID_TO: "end" });
  });
});

function view(name: string, sqlText: string) {
  return { space: "S", kind: "views" as const, technicalName: name, definition: { definitions: { [name]: { kind: "entity", "@DataWarehouse.sqlEditor.query": sqlText } } } };
}
