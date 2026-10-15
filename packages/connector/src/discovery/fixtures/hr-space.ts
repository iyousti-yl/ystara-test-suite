import type { RawObject } from "../scan.js";

/**
 * A synthetic HR space. All names are made up; nothing here comes from a real
 * tenant. Flow shapes follow what the CLI returns: steps under
 * `contents.processes.<step>` with a `component`, written tables also listed as
 * keys of `dataflows.<DF>.targets`, SQL steps of transformation flows in
 * `metadata.config.definition`.
 *
 * The pipeline behind V_HEADCOUNT_OUT:
 *
 *   DF_SF_EMPLOYEE (write step "producer1") ==> LT_EMPLOYEE_RAW
 *     --> V_EMPLOYEE_CLEAN (WHERE EXISTS on the control view below)
 *       --> TF_EMPLOYEE_ENRICH ==> LT_EMPLOYEE_ENRICHED
 *         --> TF_HEADCOUNT (joins config table LT_HR_CONFIG, delta on its own target) ==> LT_HEADCOUNT
 *           --> V_HEADCOUNT_OUT (joins LT_ORG_DIM)
 *   Side input: V_ACTIVE_ORG_FILTER (control view) reads LT_ORG_FILTER (filter table)
 *               and LT_ORG_RAW (ingestion table, loaded by DF_SF_ORG)
 *
 * Traps that must stay out of the pipeline:
 *   - DF_EMPLOYEE_BACKFILL also writes LT_EMPLOYEE_RAW (another process, reads LT_EMPLOYEE_ARCHIVE)
 *   - LT_LEGACY_ORG (and DF_LEGACY_ORG, which loads it) appear only in a commented-out JOIN
 *   - V_UNRELATED appears only in a SQL comment
 *   - TC_HR_DAILY runs the flows and clears a table, but is orchestration
 */
const table = (name: string, columns: string[]) => ({
  definitions: {
    [name]: {
      kind: "entity",
      elements: Object.fromEntries(columns.map((c, i) => [c, { type: "cds.String", length: 40, key: i === 0 }])),
    },
  },
});

const dataFlow = (name: string, processes: Record<string, unknown>, targets: string[]) => ({
  dataflows: {
    [name]: {
      kind: "sap.dis.dataflow",
      contents: { processes },
      targets: Object.fromEntries(targets.map((t) => [t, { kind: "entity" }])),
    },
  },
});

/** Reads a remote source through a connection (not a node yet). */
const appConsumer = (connection: string, remoteObject: string) => ({
  component: "com.sap.application.consumer.v2",
  metadata: { config: { connectionName: connection, remoteObjectReference: { name: remoteObject } } },
});
const tableConsumer = (entity: string) => ({ component: "com.sap.database.table.consumer", metadata: { config: { dwcEntity: entity } } });
const tableProducer = (entity?: string) => ({
  component: "com.sap.database.table.producer",
  metadata: { config: { ...(entity ? { dwcEntity: entity } : {}), mode: "append" } },
});

const transformationFlow = (name: string, sql: string, target: string) => ({
  transformationflows: {
    [name]: {
      kind: "sap.dwc.transformationflow",
      contents: {
        processes: {
          sql1: { component: "com.sap.dwc.sqlscript", metadata: { config: { definition: sql } } },
          // Named neither "target" nor "producer": the component decides.
          step2: { component: "com.sap.dwc.target", metadata: { config: { name: target, loadType: "INITIAL_AND_DELTA" } } },
        },
      },
    },
  },
});

const sqlView = (name: string, sql: string, extra: Record<string, unknown> = {}) => ({
  definitions: { [name]: { kind: "entity", "@DataWarehouse.sqlEditor.query": sql, ...extra } },
});

export const HR_SPACE: RawObject[] = [
  { space: "HR", kind: "local-tables", technicalName: "LT_EMPLOYEE_RAW", definition: table("LT_EMPLOYEE_RAW", ["EMP_ID", "MANAGER_ID", "HIRE_DATE", "STATUS", "ORG_ID"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_EMPLOYEE_ARCHIVE", definition: table("LT_EMPLOYEE_ARCHIVE", ["EMP_ID", "HIRE_DATE", "ORG_ID"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_EMPLOYEE_ENRICHED", definition: table("LT_EMPLOYEE_ENRICHED", ["EMP_ID", "ORG_ID", "TENURE"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_HEADCOUNT", definition: table("LT_HEADCOUNT", ["ORG_ID", "REPORTING_YEAR", "HEADCOUNT"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_HR_CONFIG", definition: table("LT_HR_CONFIG", ["PARAM", "VALUE"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_ORG_RAW", definition: table("LT_ORG_RAW", ["ORG_ID", "ORG_NAME"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_ORG_FILTER", definition: table("LT_ORG_FILTER", ["ORG_ID", "ACTIVE"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_ORG_DIM", definition: table("LT_ORG_DIM", ["ORG_ID", "ORG_NAME"]) },
  { space: "HR", kind: "local-tables", technicalName: "LT_LEGACY_ORG", definition: table("LT_LEGACY_ORG", ["ORG_ID", "OLD_CODE"]) },

  // Case: the write step is called producer1, not target*.
  {
    space: "HR",
    kind: "data-flows",
    technicalName: "DF_SF_EMPLOYEE",
    definition: dataFlow("DF_SF_EMPLOYEE", { consumer1: appConsumer("SF_SYNTH", "PerPerson"), producer1: tableProducer("LT_EMPLOYEE_RAW") }, ["LT_EMPLOYEE_RAW"]),
  },
  // Case: a second writer of LT_EMPLOYEE_RAW from another process. Its target is known only from the `targets` section.
  {
    space: "HR",
    kind: "data-flows",
    technicalName: "DF_EMPLOYEE_BACKFILL",
    definition: dataFlow("DF_EMPLOYEE_BACKFILL", { consumer1: tableConsumer("LT_EMPLOYEE_ARCHIVE"), producer1: tableProducer() }, ["LT_EMPLOYEE_RAW"]),
  },
  {
    space: "HR",
    kind: "data-flows",
    technicalName: "DF_SF_ORG",
    definition: dataFlow("DF_SF_ORG", { consumer1: appConsumer("SF_SYNTH", "FOCompany"), producer1: tableProducer("LT_ORG_RAW") }, ["LT_ORG_RAW"]),
  },
  {
    space: "HR",
    kind: "data-flows",
    technicalName: "DF_LEGACY_ORG",
    definition: dataFlow("DF_LEGACY_ORG", { consumer1: appConsumer("LEGACY_SYNTH", "ORG"), producer1: tableProducer("LT_LEGACY_ORG") }, ["LT_LEGACY_ORG"]),
  },

  // Case: a control view built on a filter table and an ingestion table (graphical view, CSN query only).
  {
    space: "HR",
    kind: "views",
    technicalName: "V_ACTIVE_ORG_FILTER",
    definition: {
      definitions: {
        V_ACTIVE_ORG_FILTER: {
          kind: "entity",
          "@DataWarehouse.querybuilder.model": { output: "V_ACTIVE_ORG_FILTER" },
          query: {
            SELECT: {
              from: { join: "inner", args: [{ ref: ["LT_ORG_RAW"], as: "r" }, { ref: ["LT_ORG_FILTER"], as: "f" }], on: [{ ref: ["r", "ORG_ID"] }, "=", { ref: ["f", "ORG_ID"] }] },
              where: [{ ref: ["f", "ACTIVE"] }, "=", { val: "X" }],
              columns: [{ ref: ["r", "ORG_ID"] }],
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
          "@DataWarehouse.sqlEditor.query": `SELECT r."EMP_ID", r."MANAGER_ID", r."ORG_ID", r."HIRE_DATE"
FROM "LT_EMPLOYEE_RAW" r
WHERE r."STATUS" = 'A'
  AND EXISTS (SELECT 1 FROM "V_ACTIVE_ORG_FILTER" f WHERE f."ORG_ID" = r."ORG_ID")`,
          query: { SELECT: { from: { ref: ["LT_EMPLOYEE_RAW"], as: "r" }, columns: [{ ref: ["r", "EMP_ID"] }] } },
        },
        // The CLI may include dependency definitions; they must not create edges for this view.
        LT_EMPLOYEE_RAW: { kind: "entity", "@DataWarehouse.remote.entity": "DF_SF_EMPLOYEE" },
      },
    },
  },

  // Case: a commented-out JOIN to an unrelated table, in both comment styles.
  {
    space: "HR",
    kind: "transformation-flows",
    technicalName: "TF_EMPLOYEE_ENRICH",
    definition: transformationFlow(
      "TF_EMPLOYEE_ENRICH",
      `SELECT e."EMP_ID", e."ORG_ID", DAYS_BETWEEN(e."HIRE_DATE", CURRENT_DATE) / 365 AS "TENURE"
FROM "V_EMPLOYEE_CLEAN" e
/* replaced by the org filter:
LEFT JOIN "LT_LEGACY_ORG" l ON l."ORG_ID" = e."ORG_ID" */
-- LEFT JOIN LT_LEGACY_ORG l ON l.ORG_ID = e.ORG_ID
WHERE e."ORG_ID" IS NOT NULL`,
      "LT_EMPLOYEE_ENRICHED",
    ),
  },
  // Case: a config table as side input, and a delta check on the flow's own target.
  {
    space: "HR",
    kind: "transformation-flows",
    technicalName: "TF_HEADCOUNT",
    definition: transformationFlow(
      "TF_HEADCOUNT",
      `SELECT e."ORG_ID", c."VALUE" AS "REPORTING_YEAR", COUNT(*) AS "HEADCOUNT"
FROM "LT_EMPLOYEE_ENRICHED" e
CROSS JOIN "LT_HR_CONFIG" c
WHERE c."PARAM" = 'REPORTING_YEAR'
  AND NOT EXISTS (SELECT 1 FROM "LT_HEADCOUNT" h WHERE h."ORG_ID" = e."ORG_ID" AND h."REPORTING_YEAR" = c."VALUE")
GROUP BY e."ORG_ID", c."VALUE"`,
      "LT_HEADCOUNT",
    ),
  },
  {
    space: "HR",
    kind: "views",
    technicalName: "V_HEADCOUNT_OUT",
    definition: sqlView(
      "V_HEADCOUNT_OUT",
      `-- Consumed by an integration flow. Was built on V_UNRELATED before.
SELECT h."ORG_ID", d."ORG_NAME", h."REPORTING_YEAR", h."HEADCOUNT"
FROM "LT_HEADCOUNT" h
LEFT JOIN "LT_ORG_DIM" d ON h."ORG_ID" = d."ORG_ID"`,
      { "@DataWarehouse.consumption.external": true },
    ),
  },
  {
    space: "HR",
    kind: "views",
    technicalName: "V_UNRELATED",
    definition: { definitions: { V_UNRELATED: { kind: "entity", query: { SELECT: { from: { ref: ["LT_ORG_DIM"] } } } } } },
  },

  // Case: a task chain over the pipeline, including a step that clears a table before reload.
  {
    space: "HR",
    kind: "task-chains",
    technicalName: "TC_HR_DAILY",
    definition: {
      taskchains: {
        TC_HR_DAILY: {
          nodes: [
            { id: 1, taskIdentifier: { applicationId: "DATAFLOWS", objectId: "DF_SF_EMPLOYEE" } },
            { id: 2, taskIdentifier: { applicationId: "DATAFLOWS", objectId: "DF_SF_ORG" } },
            { id: 3, taskIdentifier: { applicationId: "LOCAL_TABLE", activity: "DELETE_DATA", objectId: "LT_EMPLOYEE_ENRICHED" } },
            { id: 4, taskIdentifier: { applicationId: "TRANSFORMATION_FLOWS", objectId: "TF_EMPLOYEE_ENRICH" } },
            { id: 5, taskIdentifier: { applicationId: "TRANSFORMATION_FLOWS", objectId: "TF_HEADCOUNT" } },
          ],
        },
      },
    },
  },
];
