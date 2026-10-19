import type { RawObject } from "../../discovery/scan.js";

/**
 * A synthetic sales space for simulation tests. All names are made up. Its
 * SQL is plain enough to run on PostgreSQL too, so a test can check what the
 * composed query returns, not only how it reads.
 *
 *   DF_ORDERS ==> LT_ORDERS --> V_OPEN_ORDERS (SQL, a filter)
 *     --> V_REGION_TOTALS (graphical: joins LT_CUSTOMERS, sums per region)
 *       --> TF_REGION_LOAD (SQL, skips regions already in its own target) ==> LT_REGION_TOTALS
 *         --> V_REGION_OUT (SQL, the table's name unquoted)
 */
const table = (name: string, columns: Record<string, Record<string, unknown>>) => ({
  definitions: { [name]: { kind: "entity", elements: columns } },
});
const text = (length: number) => ({ type: "cds.String", length });
const amount = { type: "cds.Decimal", precision: 15, scale: 2 };

export const SALES_SPACE: RawObject[] = [
  { space: "SALES", kind: "local-tables", technicalName: "LT_ORDERS", definition: table("LT_ORDERS", { ORDER_ID: text(10), CUSTOMER_ID: text(10), AMOUNT: amount, STATUS: text(10) }) },
  { space: "SALES", kind: "local-tables", technicalName: "LT_CUSTOMERS", definition: table("LT_CUSTOMERS", { CUSTOMER_ID: text(10), REGION: text(20), _ORDERS: { type: "cds.Association" } }) },
  { space: "SALES", kind: "local-tables", technicalName: "LT_REGION_TOTALS", definition: table("LT_REGION_TOTALS", { REGION: text(20), TOTAL: amount }) },
  {
    space: "SALES",
    kind: "data-flows",
    technicalName: "DF_ORDERS",
    definition: {
      dataflows: {
        DF_ORDERS: {
          kind: "sap.dis.dataflow",
          contents: {
            processes: {
              consumer1: { component: "com.sap.application.consumer.v2", metadata: { config: { connectionName: "SYNTH", remoteObjectReference: { name: "Orders" } } } },
              producer1: { component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: "LT_ORDERS", mode: "append" } } },
            },
          },
          targets: { LT_ORDERS: { kind: "entity" } },
        },
      },
    },
  },
  {
    space: "SALES",
    kind: "views",
    technicalName: "V_OPEN_ORDERS",
    definition: {
      definitions: {
        V_OPEN_ORDERS: {
          kind: "entity",
          "@DataWarehouse.sqlEditor.query": `SELECT o."ORDER_ID", o."CUSTOMER_ID", o."AMOUNT"
FROM "LT_ORDERS" o -- only open ones
WHERE o."STATUS" = 'OPEN';`,
        },
      },
    },
  },
  {
    space: "SALES",
    kind: "views",
    technicalName: "V_REGION_TOTALS",
    definition: {
      definitions: {
        V_REGION_TOTALS: {
          kind: "entity",
          "@DataWarehouse.querybuilder.model": { output: "V_REGION_TOTALS" },
          query: {
            SELECT: {
              from: {
                join: "inner",
                args: [
                  { ref: ["V_OPEN_ORDERS"], as: "o" },
                  { ref: ["LT_CUSTOMERS"], as: "c" },
                ],
                on: [{ ref: ["o", "CUSTOMER_ID"] }, "=", { ref: ["c", "CUSTOMER_ID"] }],
              },
              columns: [
                { ref: ["c", "REGION"] },
                { func: "sum", args: [{ ref: ["o", "AMOUNT"] }], as: "TOTAL" },
                { xpr: ["case", "when", { func: "count", args: ["*"] }, ">", { val: 1 }, "then", { val: "MANY" }, "else", { val: "ONE" }, "end"], as: "SIZE" },
              ],
              groupBy: [{ ref: ["c", "REGION"] }],
            },
          },
        },
      },
    },
  },
  {
    space: "SALES",
    kind: "transformation-flows",
    technicalName: "TF_REGION_LOAD",
    definition: {
      transformationflows: {
        TF_REGION_LOAD: {
          kind: "sap.dwc.transformationflow",
          contents: {
            processes: {
              sqltransform1: {
                component: "com.sap.dwc.sqltransform",
                metadata: {
                  config: {
                    // The SQL step as a CSN entity: its SQL text (with comments and a final semicolon), its CQN and its columns.
                    definition: {
                      kind: "entity",
                      "@DataWarehouse.sqlEditor.query": `-- Regions not loaded yet
-- (a delta check on the flow's own target)
SELECT "REGION", "TOTAL" FROM "V_REGION_TOTALS"
WHERE NOT EXISTS (SELECT 1 FROM "LT_REGION_TOTALS" t WHERE t."REGION" = "V_REGION_TOTALS"."REGION");
`,
                      query: {
                        SELECT: {
                          from: { ref: ["V_REGION_TOTALS"] },
                          columns: [{ ref: ["REGION"] }, { ref: ["TOTAL"] }],
                          where: [
                            "not",
                            "exists",
                            {
                              SELECT: {
                                from: { ref: ["LT_REGION_TOTALS"], as: "t" },
                                columns: [{ val: 1 }],
                                where: [{ ref: ["t", "REGION"] }, "=", { ref: ["V_REGION_TOTALS", "REGION"] }],
                              },
                            },
                          ],
                        },
                      },
                      elements: { REGION: text(20), TOTAL: amount },
                    },
                  },
                },
              },
              target1: { component: "com.sap.dwc.target", metadata: { config: { name: "LT_REGION_TOTALS", loadType: "INITIAL_AND_DELTA" } } },
            },
          },
        },
      },
    },
  },
  {
    space: "SALES",
    kind: "views",
    technicalName: "V_REGION_OUT",
    definition: {
      definitions: {
        V_REGION_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'select "REGION", "TOTAL" from LT_REGION_TOTALS order by "REGION"' },
      },
    },
  },
];
