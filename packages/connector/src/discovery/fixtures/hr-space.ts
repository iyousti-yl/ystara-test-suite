import type { RawObject } from "../scan.js";

/**
 * A synthetic HR space shaped like the SuccessFactors-to-CPI reference case:
 *
 *   DF_SF_EMPLOYEE (data flow, reads SuccessFactors via a connection)
 *     ==> LT_EMPLOYEE_RAW
 *       --> V_EMPLOYEE_CLEAN (SQL view)
 *         --> TF_EMPLOYEE_ENRICH ==> LT_EMPLOYEE_ENRICHED
 *           --> TF_HEADCOUNT ==> LT_HEADCOUNT
 *             --> V_HEADCOUNT_OUT (SQL view, joins LT_ORG_DIM, consumed by CPI)
 *   TC_HR_DAILY (task chain) runs DF_SF_EMPLOYEE, TF_EMPLOYEE_ENRICH, TF_HEADCOUNT
 *   V_UNRELATED reads LT_ORG_DIM only and must not appear in the pipeline.
 *
 * Flow and task chain shapes are deliberately approximate: the reference
 * scanner must not depend on their exact layout. Replace with sanitised real
 * samples once available.
 */
const table = (name: string, columns: string[]) => ({
  definitions: {
    [name]: {
      kind: "entity",
      elements: Object.fromEntries(columns.map((c, i) => [c, { type: "cds.String", length: 40, key: i === 0 }])),
    },
  },
});

export const HR_SPACE: RawObject[] = [
  { space: "HR", kind: "local-tables", technicalName: "LT_EMPLOYEE_RAW", definition: table("LT_EMPLOYEE_RAW", ["EMP_ID", "MANAGER_ID", "HIRE_DATE", "STATUS", "ORG_ID"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_EMPLOYEE_ENRICHED", definition: table("LT_EMPLOYEE_ENRICHED", ["EMP_ID", "ORG_ID", "TENURE"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_HEADCOUNT", definition: table("LT_HEADCOUNT", ["ORG_ID", "HEADCOUNT"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_ORG_DIM", definition: table("LT_ORG_DIM", ["ORG_ID", "ORG_NAME"]) },
  {
    space: "HR",
    kind: "data-flows",
    technicalName: "DF_SF_EMPLOYEE",
    definition: {
      dataflows: {
        DF_SF_EMPLOYEE: {
          contents: {
            processes: {
              source1: { component: "source", metadata: { config: { connection: "SF_PROD", remoteObject: "PerPerson" } } },
              target1: { component: "target", metadata: { config: { entity: "LT_EMPLOYEE_RAW", mode: "APPEND" } } },
            },
          },
        },
      },
    },
  },
  {
    space: "HR",
    kind: "views",
    technicalName: "V_EMPLOYEE_CLEAN",
    definition: {
      definitions: {
        V_EMPLOYEE_CLEAN: {
          kind: "entity",
          "@DataWarehouse.sqlEditor.query":
            'SELECT "EMP_ID", "MANAGER_ID", "ORG_ID" FROM "LT_EMPLOYEE_RAW" WHERE "STATUS" = \'A\'',
          query: { SELECT: { from: { ref: ["LT_EMPLOYEE_RAW"] }, columns: [{ ref: ["EMP_ID"] }] } },
        },
        // The CLI may include dependency definitions; they must not create edges for this view.
        LT_EMPLOYEE_RAW: { kind: "entity", "@DataWarehouse.remote.entity": "DF_SF_EMPLOYEE" },
      },
    },
  },
  {
    space: "HR",
    kind: "transformation-flows",
    technicalName: "TF_EMPLOYEE_ENRICH",
    definition: {
      transformationflows: {
        TF_EMPLOYEE_ENRICH: {
          contents: { source: { entity: "V_EMPLOYEE_CLEAN" }, target: { entity: "LT_EMPLOYEE_ENRICHED", loadType: "INITIAL_AND_DELTA" } },
        },
      },
    },
  },
  {
    space: "HR",
    kind: "transformation-flows",
    technicalName: "TF_HEADCOUNT",
    definition: {
      transformationflows: {
        TF_HEADCOUNT: {
          contents: {
            sqlScript: 'SELECT "ORG_ID", COUNT(*) AS "HEADCOUNT" FROM "LT_EMPLOYEE_ENRICHED" GROUP BY "ORG_ID"',
            targetTable: "LT_HEADCOUNT",
          },
        },
      },
    },
  },
  {
    space: "HR",
    kind: "views",
    technicalName: "V_HEADCOUNT_OUT",
    definition: {
      definitions: {
        V_HEADCOUNT_OUT: {
          kind: "entity",
          "@DataWarehouse.consumption.external": true,
          "@DataWarehouse.sqlEditor.query":
            'SELECT h."ORG_ID", d."ORG_NAME", h."HEADCOUNT" FROM "LT_HEADCOUNT" h LEFT JOIN "LT_ORG_DIM" d ON h."ORG_ID" = d."ORG_ID"',
        },
      },
    },
  },
  {
    space: "HR",
    kind: "views",
    technicalName: "V_UNRELATED",
    definition: { definitions: { V_UNRELATED: { kind: "entity", query: { SELECT: { from: { ref: ["LT_ORG_DIM"] } } } } } },
  },
  {
    space: "HR",
    kind: "task-chains",
    technicalName: "TC_HR_DAILY",
    definition: {
      taskchains: {
        TC_HR_DAILY: {
          nodes: [
            { id: 1, taskIdentifier: { applicationId: "DATAFLOWS", objectId: "DF_SF_EMPLOYEE" } },
            { id: 2, taskIdentifier: { applicationId: "TRANSFORMATION_FLOWS", objectId: "TF_EMPLOYEE_ENRICH" } },
            { id: 3, taskIdentifier: { applicationId: "TRANSFORMATION_FLOWS", objectId: "TF_HEADCOUNT" } },
          ],
        },
      },
    },
  },
];
