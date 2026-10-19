import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { refKey } from "@ystara/shared";
import { HR_SPACE } from "../discovery/fixtures/hr-space.js";
import { buildPipeline } from "../discovery/graph.js";
import { graphFromRaw } from "../discovery/scan.js";
import { assertSelectOnly } from "../readonly.js";
import { compileCsnQuery } from "./csn.js";
import { fixtureQuery, sampleRows, tableColumns } from "./fixtures.js";
import { fragment, SimulationStop, type Fragment } from "./fragment.js";
import { SALES_SPACE } from "./fixtures/sales-space.js";
import { simulatePipeline } from "./simulate.js";
import { assertReadsOnlyDummy, inlineReferences } from "./sql-text.js";

/** A composed query must read nothing but DUMMY: every FROM and JOIN opens a subquery or names DUMMY. */
function readsOnlyDummy(sql: string) {
  const outside = sql.replace(/'(?:[^']|'')*'/g, "''");
  return !/\b(?:FROM|JOIN)\s+(?!\(|DUMMY\b)/i.test(outside);
}

const stopsWith = (run: () => unknown, message: RegExp) => {
  expect(run).toThrow(SimulationStop);
  expect(run).toThrow(message);
};

describe("fixtures", () => {
  const columns = [
    { name: "EMP_ID", type: "NVARCHAR(10)" },
    { name: "SALARY", type: "DECIMAL(15, 2)" },
    { name: "HIRED", type: "DATE" },
  ];

  it("inline each row from DUMMY, with every value bound and missing ones NULL", () => {
    const q = fixtureQuery("LT_EMP", columns, [{ EMP_ID: "E1", SALARY: 10.5, HIRED: "2026-01-15" }, { EMP_ID: "E2" }]);
    expect(q.sql).toBe(
      'SELECT CAST(? AS NVARCHAR(10)) AS "EMP_ID", CAST(? AS DECIMAL(15, 2)) AS "SALARY", CAST(? AS DATE) AS "HIRED" FROM DUMMY' +
        ' UNION ALL SELECT CAST(? AS NVARCHAR(10)) AS "EMP_ID", CAST(NULL AS DECIMAL(15, 2)) AS "SALARY", CAST(NULL AS DATE) AS "HIRED" FROM DUMMY',
    );
    expect(q.params).toEqual(["E1", 10.5, "2026-01-15", "E2"]);
  });

  it("keep the columns of an empty table, and refuse a column the table doesn't have", () => {
    expect(fixtureQuery("LT_EMP", columns, []).sql).toBe(
      'SELECT CAST(NULL AS NVARCHAR(10)) AS "EMP_ID", CAST(NULL AS DECIMAL(15, 2)) AS "SALARY", CAST(NULL AS DATE) AS "HIRED" FROM DUMMY WHERE 1 = 0',
    );
    stopsWith(() => fixtureQuery("LT_EMP", columns, [{ EMP_ID: "E1", BONUS: 1 }]), /LT_EMP has columns the table doesn't have: BONUS/);
  });

  it("read a table's columns and types from its CSN, skipping associations", () => {
    const definition = {
      definitions: {
        LT_X: {
          elements: {
            ID: { type: "cds.String", length: 10, key: true },
            N: { type: "cds.Integer64" },
            D: { type: "cds.Decimal", precision: 5, scale: 1 },
            TO_Y: { type: "cds.Association" },
            ODD: { type: "SALES.MyType" },
          },
        },
      },
    };
    expect(tableColumns(definition, "LT_X")).toEqual({
      columns: [
        { name: "ID", type: "NVARCHAR(10)" },
        { name: "N", type: "BIGINT" },
        { name: "D", type: "DECIMAL(5, 1)" },
        { name: "ODD", type: "NVARCHAR(5000)" },
      ],
      unknownTypes: ["ODD (SALES.MyType)"],
    });
  });

  it("make up rows with the same keys in every table, so generated tables join", () => {
    expect(sampleRows([...columns, { name: "OK", type: "BOOLEAN" }], 2)).toEqual([
      { EMP_ID: "1", SALARY: 1, HIRED: "2026-01-01", OK: true },
      { EMP_ID: "2", SALARY: 2, HIRED: "2026-01-02", OK: false },
    ]);
  });
});

describe("SQL text", () => {
  const known = new Set(["LT_A", "LT_B", "V_C", "HR.LT_A"]);
  const isKnown = (parts: string[]) => known.has(parts.join("."));
  const resolve = (parts: string[]) => (isKnown(parts) ? fragment(`SELECT ? AS "X" FROM DUMMY`, [parts.join(".")]) : undefined);
  const inline = (sql: string) => inlineReferences(sql, resolve, isKnown);

  it("replaces what FROM and JOIN read, keeping aliases, and adds the name as alias when there is none", () => {
    const q = inline('SELECT a."X", LT_B."X" FROM "LT_A" a LEFT JOIN LT_B ON a."X" = LT_B."X", "HR"."LT_A" AS h');
    expect(q.sql).toBe(
      'SELECT a."X", LT_B."X" FROM (SELECT ? AS "X" FROM DUMMY) a LEFT JOIN (SELECT ? AS "X" FROM DUMMY) AS "LT_B" ON a."X" = LT_B."X", (SELECT ? AS "X" FROM DUMMY) AS h',
    );
    expect(q.params).toEqual(["LT_A", "LT_B", "HR.LT_A"]);
  });

  it("finds reads in subqueries, drops comments and a final semicolon, and leaves strings alone", () => {
    const q = inline(`SELECT 'FROM LT_B' AS "T" -- reads LT_B? no
FROM "V_C" c /* JOIN LT_B */ WHERE EXISTS (SELECT 1 FROM "LT_A" a WHERE a."X" = c."X");`);
    expect(q.params).toEqual(["V_C", "LT_A"]);
    expect(q.sql).not.toMatch(/--|\/\*|;/);
    expect(q.sql).toContain("'FROM LT_B'");
    expect(() => assertSelectOnly(q.sql)).not.toThrow();
  });

  it("stops when a known name is in a place it can't place, when a read isn't in the scan, or when the SQL isn't one SELECT", () => {
    stopsWith(() => inline('SELECT * FROM "LT_A" WHERE "X" IN (SELECT "X" FROM V_UNKNOWN)'), /reads V_UNKNOWN, which isn't in the scan/);
    stopsWith(() => inline('SELECT * FROM "LT_A"("P" => 1)'), /calls LT_A with parameters/);
    stopsWith(() => inline('WITH t AS (SELECT 1 FROM DUMMY) SELECT * FROM t'), /starts with WITH/);
    stopsWith(() => inline("RETURN SELECT * FROM LT_A"), /isn't a single SELECT/);
    stopsWith(() => inline("SELECT * FROM LT_A; SELECT * FROM LT_B"), /more than one statement/);
  });

  it("replaces reads inside a join group, and stops on one there that isn't in the scan", () => {
    expect(inline('SELECT * FROM ("LT_A" a JOIN "LT_B" b ON a."X" = b."X")').params).toEqual(["LT_A", "LT_B"]);
    stopsWith(() => inline('SELECT * FROM ("OTHER"."TCURR" t JOIN "LT_A" a ON t."X" = a."X")'), /reads OTHER.TCURR, which isn't in the scan/);
  });

  it("doesn't take the FROM of a function for a read", () => {
    const q = inline("SELECT EXTRACT(YEAR FROM a.\"D\") AS \"Y\", TRIM(BOTH ' ' FROM a.\"T\") AS \"T\" FROM \"LT_A\" a");
    expect(q.params).toEqual(["LT_A"]);
    expect(q.sql).toContain('EXTRACT(YEAR FROM a."D")');
  });

  it("leaves DUMMY as it is", () => {
    expect(inline("SELECT 1 AS \"N\" FROM DUMMY").sql).toBe('SELECT 1 AS "N" FROM DUMMY');
  });

  it("are checked last for any read that isn't a subquery or DUMMY, whatever compiled them", () => {
    expect(() => assertReadsOnlyDummy('SELECT * FROM (SELECT 1 AS "N" FROM DUMMY) AS "Q" JOIN (SELECT 2 FROM SYS.DUMMY) AS "P" ON 1 = 1')).not.toThrow();
    stopsWith(() => assertReadsOnlyDummy('SELECT * FROM (SELECT 1 FROM DUMMY) AS "Q" UNION SELECT X FROM REALTABLE'), /would read REALTABLE itself/);
    stopsWith(() => assertReadsOnlyDummy('SELECT * FROM (SELECT 1 FROM DUMMY) q, "HR"."LT_A"'), /would read HR.LT_A itself/);
  });
});

describe("CSN queries", () => {
  const resolve = (parts: string[]) => fragment(`SELECT * FROM DUMMY /* ${parts.join(".")} */`);
  const compile = (query: unknown) => compileCsnQuery(query, resolve).sql;

  it("compile joins, filters, calculated columns, grouping, order and limit", () => {
    const sql = compile({
      SELECT: {
        distinct: true,
        from: {
          join: "left",
          args: [
            { join: "inner", args: [{ ref: ["LT_A"], as: "a" }, { ref: ["LT_B"], as: "b" }], on: [{ ref: ["a", "K"] }, "=", { ref: ["b", "K"] }] },
            { ref: ["SHARED.V_C"] },
          ],
          on: [{ ref: ["a", "K"] }, "=", { ref: ["SHARED.V_C", "K"] }],
        },
        columns: [
          { ref: ["a", "K"], as: "KEY" },
          { func: "coalesce", args: [{ ref: ["b", "N"] }, { val: 0 }], as: "N" },
          { ref: ["a", "D"], cast: { type: "cds.Date" }, as: "D" },
          { xpr: [{ ref: ["a", "T"] }, "||", { val: "it's" }], as: "T" },
        ],
        where: [{ ref: ["a", "S"] }, "in", { list: [{ val: "A" }, { val: "B" }] }, "and", { ref: ["b", "F"] }, "is not", "null"],
        groupBy: [{ ref: ["a", "K"] }],
        having: [{ func: "count", args: ["*"] }, ">", { val: 1 }],
        orderBy: [{ ref: ["KEY"], sort: "desc", nulls: "last" }],
        limit: { rows: { val: 10 }, offset: { val: 5 } },
      },
    });
    expect(sql).toBe(
      'SELECT DISTINCT "a"."K" AS "KEY", COALESCE("b"."N", 0) AS "N", CAST("a"."D" AS DATE) AS "D", ("a"."T" || \'it\'\'s\') AS "T"' +
        ' FROM (SELECT * FROM DUMMY /* LT_A */) AS "a" INNER JOIN (SELECT * FROM DUMMY /* LT_B */) AS "b" ON "a"."K" = "b"."K"' +
        ' LEFT OUTER JOIN (SELECT * FROM DUMMY /* SHARED.V_C */) AS "SHARED.V_C" ON "a"."K" = "SHARED.V_C"."K"' +
        ' WHERE "a"."S" IN (\'A\', \'B\') AND "b"."F" IS NOT NULL GROUP BY "a"."K" HAVING COUNT(*) > 1 ORDER BY "KEY" DESC NULLS LAST LIMIT 10 OFFSET 5',
    );
  });

  it("compile a union, each side in its own subquery", () => {
    expect(compile({ SET: { op: "union", all: true, args: [{ SELECT: { from: { ref: ["LT_A"] } } }, { SELECT: { from: { ref: ["LT_B"] } } }] } })).toBe(
      'SELECT * FROM (SELECT * FROM (SELECT * FROM DUMMY /* LT_A */) AS "LT_A") AS "_1" UNION ALL SELECT * FROM (SELECT * FROM (SELECT * FROM DUMMY /* LT_B */) AS "LT_B") AS "_2"',
    );
  });

  it("stop on what they can't compile yet, naming the construct", () => {
    stopsWith(() => compile({ SELECT: { from: { ref: [{ id: "V_P", args: { P: { val: 1 } } }] } } }), /passes parameters or a filter/);
    stopsWith(() => compile({ SELECT: { from: { ref: ["LT_A"] }, columns: [{ ref: ["P"], param: true }] } }), /input parameter/);
    stopsWith(() => compile({ SELECT: { from: { ref: ["LT_A"] }, mixin: {} } }), /uses mixin/);
    stopsWith(() => compile({ SELECT: { from: { ref: ["LT_A"] }, where: [{ ref: ["X"] }, "; drop", { val: 1 }] } }), /doesn't write into SQL/);
    stopsWith(() => compile({ SELECT: { from: { ref: ["LT_A"] }, where: [{ ref: ["X"] }, "=", { val: 1 }, "union select x from realtable"] } }), /doesn't write into SQL/);
    stopsWith(() => compile({ SELECT: { from: { join: "inner", args: [{ ref: ["LT_A"] }, { ref: ["LT_B"] }, { ref: ["LT_C"] }] } } }), /exactly two sides/);
    stopsWith(() => compile({ SELECT: { one: true, from: { ref: ["LT_A"] } } }), /uses one/);
    stopsWith(() => compile({ SELECT: { from: { ref: ["LT_A"] }, columns: [{ ref: ["TO_B"], expand: ["*"] }] } }), /expands an association/);
  });
});

describe("a pipeline simulation", () => {
  it("stands in for every step of the HR pipeline, reading nothing but DUMMY", () => {
    const graph = graphFromRaw(HR_SPACE, ["HR"]);
    const pipeline = buildPipeline(graph, { space: "HR", technicalName: "V_HEADCOUNT_OUT" });
    const sim = simulatePipeline(graph, pipeline);
    const note = (name: string) => sim.steps.find((s) => s.ref.technicalName === name)!;

    expect(sim.steps.filter((s) => s.problem)).toEqual([]);
    expect(note("LT_EMPLOYEE_RAW").note).toMatch(/^fixture with 3 made-up rows, because 2 flows load it/);
    expect(note("LT_ORG_RAW").note).toMatch(/because DF_SF_ORG loads it, and a data flow can't be expressed in SQL/);
    expect(note("V_ACTIVE_ORG_FILTER").note).toBe("compiled from its CSN query");
    expect(note("V_EMPLOYEE_CLEAN").note).toBe("compiled from its SQL");
    expect(note("TF_HEADCOUNT").note).toBe("compiled from its SQL step; its own target LT_HEADCOUNT starts empty (full load)");
    expect(note("LT_HEADCOUNT").note).toBe("the SELECT of TF_HEADCOUNT (full load)");
    expect(note("DF_SF_EMPLOYEE").query).toBeUndefined();
    expect(note("V_HEADCOUNT_OUT").reads.map((r) => r.technicalName)).toEqual(["LT_HEADCOUNT", "LT_ORG_DIM"]);

    const out = sim.output!;
    expect(readsOnlyDummy(out.sql)).toBe(true);
    expect(() => assertSelectOnly(out.sql)).not.toThrow();
    expect(out.sql.split("?").length - 1).toBe(out.params.length);
    // Every compiled step's own query reads nothing real either.
    for (const s of sim.steps) if (s.query) expect(readsOnlyDummy(s.query.sql), refKey(s.ref)).toBe(true);
  });

  it("stops a step, and every step that reads it, when one can't be compiled; nothing falls back to the real object", () => {
    const broken = HR_SPACE.map((o) =>
      o.technicalName === "V_EMPLOYEE_CLEAN"
        ? { ...o, definition: { definitions: { V_EMPLOYEE_CLEAN: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "LT_EMPLOYEE_RAW"("P" => 1)' } } } }
        : o,
    );
    const graph = graphFromRaw(broken, ["HR"]);
    const sim = simulatePipeline(graph, buildPipeline(graph, { space: "HR", technicalName: "V_HEADCOUNT_OUT" }));
    const step = (name: string) => sim.steps.find((s) => s.ref.technicalName === name)!;
    expect(step("V_EMPLOYEE_CLEAN").problem).toMatch(/calls LT_EMPLOYEE_RAW with parameters/);
    expect(step("TF_EMPLOYEE_ENRICH").problem).toBe("it reads V_EMPLOYEE_CLEAN, which can't be simulated");
    // Made-up rows don't stand in for the broken flow's logic: its table stops, and so does what reads it.
    expect(step("LT_EMPLOYEE_ENRICHED").problem).toMatch(/TF_EMPLOYEE_ENRICH, which loads it, can't be compiled; give the table a fixture/);
    expect(step("V_HEADCOUNT_OUT").problem).toBe("it reads LT_HEADCOUNT, which can't be simulated");
    expect(sim.output).toBeUndefined();

    // Rows given for that table let the steps after it run.
    const given = simulatePipeline(graph, buildPipeline(graph, { space: "HR", technicalName: "V_HEADCOUNT_OUT" }), {
      fixtures: new Map([["LT_EMPLOYEE_ENRICHED", [{ EMP_ID: "E1", ORG_ID: "O1", TENURE: "2" }]]]),
    });
    expect(given.steps.find((s) => s.ref.technicalName === "LT_EMPLOYEE_ENRICHED")!.note).toMatch(/^fixture with 1 given row, because TF_EMPLOYEE_ENRICH, which loads it, can't be compiled/);
    expect(given.output).toBeDefined();
  });

  it("says once that a flow's own target starts empty, however often its SQL reads it", () => {
    const space = structuredClone(SALES_SPACE);
    const flow = space.find((o) => o.technicalName === "TF_REGION_LOAD")!.definition as {
      transformationflows: Record<string, { contents: { processes: Record<string, { metadata: { config: { definition: Record<string, string> } } }> } }>;
    };
    const step = flow.transformationflows.TF_REGION_LOAD.contents.processes.sqltransform1.metadata.config.definition;
    const key = "@DataWarehouse.sqlEditor.query";
    step[key] = step[key].replace(";", ' AND NOT EXISTS (SELECT 1 FROM "LT_REGION_TOTALS" u WHERE u."REGION" = "V_REGION_TOTALS"."REGION");');
    const graph = graphFromRaw(space, ["SALES"]);
    const sim = simulatePipeline(graph, buildPipeline(graph, { space: "SALES", technicalName: "V_REGION_OUT" }));
    const load = sim.steps.find((s) => s.ref.technicalName === "TF_REGION_LOAD")!;
    expect(load.note).toBe("compiled from its SQL step; its own target LT_REGION_TOTALS starts empty (full load)");
    expect(load.reads.map((r) => r.technicalName)).toEqual(["V_REGION_TOTALS", "LT_REGION_TOTALS"]);
  });

  it("returns what the pipeline's logic gives over the fixtures (run on PostgreSQL)", async () => {
    const graph = graphFromRaw(SALES_SPACE, ["SALES"]);
    const pipeline = buildPipeline(graph, { space: "SALES", technicalName: "V_REGION_OUT" });
    const fixtures = new Map([
      [
        "LT_ORDERS",
        [
          { ORDER_ID: "1", CUSTOMER_ID: "C1", AMOUNT: 10.5, STATUS: "OPEN" },
          { ORDER_ID: "2", CUSTOMER_ID: "C1", AMOUNT: 4.5, STATUS: "OPEN" },
          { ORDER_ID: "3", CUSTOMER_ID: "C2", AMOUNT: 7, STATUS: "CLOSED" },
          { ORDER_ID: "4", CUSTOMER_ID: "C2", AMOUNT: 3, STATUS: "OPEN" },
        ],
      ],
      [
        "SALES.LT_CUSTOMERS",
        [
          { CUSTOMER_ID: "C1", REGION: "NORTH" },
          { CUSTOMER_ID: "C2", REGION: "SOUTH" },
        ],
      ],
    ]);
    const sim = simulatePipeline(graph, pipeline, { fixtures });
    expect(sim.steps.filter((s) => s.problem)).toEqual([]);
    // Its flow's SQL step is a CSN entity holding the SQL text, as Datasphere stores it.
    expect(sim.steps.find((s) => s.ref.technicalName === "TF_REGION_LOAD")!.note).toBe(
      "compiled from its SQL step; its own target LT_REGION_TOTALS starts empty (full load)",
    );

    const pg = new PGlite();
    try {
      await pg.exec('create table dummy ("DUMMY" varchar(1)); insert into dummy values (\'X\')');
      const run = async (f: Fragment) => (await pg.query(toPostgres(f).sql, f.params)).rows;
      expect(await run(sim.output!)).toEqual([
        { REGION: "NORTH", TOTAL: "15.00" },
        { REGION: "SOUTH", TOTAL: "3.00" },
      ]);
      const totals = sim.steps.find((s) => s.ref.technicalName === "V_REGION_TOTALS")!;
      expect(await run(concatOrdered(totals.query!))).toEqual([
        { REGION: "NORTH", TOTAL: "15.00", SIZE: "MANY" },
        { REGION: "SOUTH", TOTAL: "3.00", SIZE: "ONE" },
      ]);
    } finally {
      await pg.close();
    }
  });
});

/** The query sorted by its first column, for a stable comparison. */
function concatOrdered(f: Fragment): Fragment {
  return { sql: `SELECT * FROM (${f.sql}) AS "_Q" ORDER BY 1`, params: f.params };
}

/** SAP HANA SQL of the synthetic pipeline as PostgreSQL reads it: numbered placeholders, VARCHAR for NVARCHAR. */
function toPostgres(f: Fragment): Fragment {
  let n = 0;
  return { sql: f.sql.replace(/\?/g, () => `$${++n}`).replace(/NVARCHAR\(/g, "VARCHAR("), params: f.params };
}
