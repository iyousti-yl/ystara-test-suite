import { createHash } from "node:crypto";
import { buildPipeline, graphFromRaw, planScenario, stepNotes, type RawObject } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createSignOff,
  createScenario,
  createScenarioRun,
  createScenarioSuite,
  createSnapshot,
  createTenant,
  deleteTenant,
  finishScenarioRun,
  finishScenarioSuite,
  finishSnapshot,
  findTenantByName,
  getScenarioRun,
  getScenarioSuite,
  getSnapshot,
  saveScanResult,
  saveScenarioAlert,
  getSnapshotDetails,
  listMembers,
  recordAuditEvent,
  saveSnapshotAlert,
  saveSnapshotObject,
  setSchedule,
  startScenarioRun,
  startScenarioSuite,
  startSnapshot,
  suiteRunIds,
  type Db,
} from "@ystara/db";
import {
  alertReasons,
  DEFAULT_ROW_DROP_PERCENT,
  nextRun,
  refKey,
  ScenarioSpec,
  type ColumnMeasures,
  type PipelineDefinition,
  type Scan,
  type ScenarioRun,
  type ScenarioSuite,
  type SignOff,
  type Snapshot,
  type Tenant,
} from "@ystara/shared";
import { BUSY_OUTPUT, BUSY_PIPELINE_NAME, BUSY_RAW } from "./demo-busy.js";

/**
 * A synthetic tenant for looking at the web app without a real one: a scan
 * of one space, a saved pipeline, two snapshots of it, a scenario that passed
 * on its own and in a suite (which the account's first admin signed off),
 * then broke in a suite after a scan. Every name is made
 * up. They are as long as Datasphere allows (technical names up to 50
 * characters, in UPPER_SNAKE for objects and camelCase for columns, with
 * names of 30, 40 and 50), so a page that can't show a long name shows it
 * here, and `npm run check:browser` reports it.
 *
 * The pipeline behind V_DEMO_DELIVERED_SHIPMENTS_BY_ROUTE_SEGMENT_OUTPUT:
 *
 *   DF_DEMO_LOAD_SHIPMENT_EVENT_FROM_CARRIER ==> LT_DEMO_CARRIER_SHIPMENT_EVENT
 *     --> V_DEMO_SHIPMENT_EVENT_CLEANSED_DELIVERED
 *       --> TF_DEMO_ENRICH_SHIPMENT_EVENTS_WITH_ROUTE_SEGMENTS (joins LT_DEMO_ROUTE_CONFIG) ==> LT_DEMO_SHIPMENT_EVENT_ENRICHED_ROUTE_SEGMENT_DAYS
 *         --> V_DEMO_DELIVERED_SHIPMENTS_BY_ROUTE_SEGMENT_OUTPUT
 *
 * The second snapshot has more rows, a changed sum and an added column, so the
 * comparison has something in each of its sections. It is marked as taken by
 * the pipeline's schedule (weekdays at 07:30, Brussels time), which the worker
 * never runs: the tenant has no database (see schedule-tick.ts). Its added
 * column raised an alert, which nobody got: nobody watches the demo.
 *
 * The pipeline also has a scenario (DEMO_SCENARIO) with one run that passed.
 * The run is made up too, since the tenant has no database to send its checks
 * to; what each check gave back is what a database gives for these rows
 * (checked on PostgreSQL), and the steps are compiled for real.
 *
 * Then a suite, as if a scan had changed the enrichment flow and its scenarios
 * had run again on their own (the worker never queues one for this tenant,
 * which has no database): the flow now counts the event in transit too, so
 * the output's rows check fails and the suite raised an alert, which nobody
 * got either.
 *
 * The same space has a second, busier process (demo-busy.ts) with its own
 * pipeline, not tested yet: sixteen input tables, tables loaded by several
 * flows and two loops, as a real tenant has them.
 */
/** "Synthetic" in the name keeps the tenant-content check from taking it for a real tenant's, as it does with the demo's object names. */
export const DEMO_TENANT = "Synthetic demo";
export const DEMO_SPACE = "DEMO";

export const DEMO_NAMES = {
  loadFlow: "DF_DEMO_LOAD_SHIPMENT_EVENT_FROM_CARRIER",
  rawTable: "LT_DEMO_CARRIER_SHIPMENT_EVENT",
  cleansedView: "V_DEMO_SHIPMENT_EVENT_CLEANSED_DELIVERED",
  enrichFlow: "TF_DEMO_ENRICH_SHIPMENT_EVENTS_WITH_ROUTE_SEGMENTS",
  enrichedTable: "LT_DEMO_SHIPMENT_EVENT_ENRICHED_ROUTE_SEGMENT_DAYS",
  configTable: "LT_DEMO_ROUTE_CONFIG",
  output: "V_DEMO_DELIVERED_SHIPMENTS_BY_ROUTE_SEGMENT_OUTPUT",
};

export const DEMO_COLUMNS = {
  tracking: "demoShipmentCarrierTrackingRef",
  window: "demoPlannedDeliveryWindowClosedTimestamp",
  share: "demoRouteSegmentDistanceShareForSecondaryCarrierKm",
  added: "demoDeliveryAttemptCountBeforeWindowEnd",
};

const n = DEMO_NAMES;
const c = DEMO_COLUMNS;

const table = (name: string, columns: string[]): RawObject => ({
  space: DEMO_SPACE,
  kind: "local-tables",
  technicalName: name,
  definition: { definitions: { [name]: { kind: "entity", elements: Object.fromEntries(columns.map((col, i) => [col, { type: "cds.String", length: 100, key: i === 0 }])) } } },
});

const view = (name: string, sql: string, extra: Record<string, unknown> = {}): RawObject => ({
  space: DEMO_SPACE,
  kind: "views",
  technicalName: name,
  definition: { definitions: { [name]: { kind: "entity", "@DataWarehouse.sqlEditor.query": sql, ...extra } } },
});

export const DEMO_RAW: RawObject[] = [
  table(n.rawTable, ["shipmentId", c.tracking, c.window, "eventType"]),
  table(n.enrichedTable, ["shipmentId", "routeSegmentId", c.share, "deliveryDays"]),
  table(n.configTable, ["PARAM", "VALUE"]),
  {
    space: DEMO_SPACE,
    kind: "data-flows",
    technicalName: n.loadFlow,
    definition: {
      dataflows: {
        [n.loadFlow]: {
          kind: "sap.dis.dataflow",
          contents: {
            processes: {
              consumer1: { component: "com.sap.application.consumer.v2", metadata: { config: { connectionName: "DEMO_CARRIER", remoteObjectReference: { name: "ShipmentEvent" } } } },
              producer1: { component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: n.rawTable, mode: "append" } } },
            },
          },
          targets: { [n.rawTable]: { kind: "entity" } },
        },
      },
    },
  },
  view(n.cleansedView, `SELECT e."shipmentId", e."${c.tracking}", e."${c.window}"\nFROM "${n.rawTable}" e\nWHERE e."eventType" = 'DELIVERED'`),
  {
    space: DEMO_SPACE,
    kind: "transformation-flows",
    technicalName: n.enrichFlow,
    definition: {
      transformationflows: {
        [n.enrichFlow]: {
          kind: "sap.dwc.transformationflow",
          contents: {
            processes: {
              sql1: {
                component: "com.sap.dwc.sqlscript",
                metadata: {
                  config: {
                    definition: `SELECT v."shipmentId", r."VALUE" AS "routeSegmentId", 0.5 AS "${c.share}", 2 AS "deliveryDays"\nFROM "${n.cleansedView}" v\nCROSS JOIN "${n.configTable}" r\nWHERE r."PARAM" = 'ROUTE'`,
                  },
                },
              },
              target: { component: "com.sap.dwc.target", metadata: { config: { name: n.enrichedTable, loadType: "INITIAL" } } },
            },
          },
        },
      },
    },
  },
  view(
    n.output,
    `SELECT s."routeSegmentId", COUNT(*) AS "deliveredShipments", SUM(s."${c.share}") AS "${c.share}"\nFROM "${n.enrichedTable}" s\nGROUP BY s."routeSegmentId"`,
    { "@DataWarehouse.consumption.external": true },
  ),
  ...BUSY_RAW,
];

/** Three shipment events, two of them deliveries, on one route segment: the output has one row that counts two shipments. */
export const DEMO_SCENARIO = ScenarioSpec.parse({
  name: "Only delivered events count",
  description: "An event still in transit is left out before the route segments are added.",
  kind: "golden",
  pipeline: `${DEMO_SPACE}.${n.output}`,
  fixtures: [
    {
      table: `${DEMO_SPACE}.${n.rawTable}`,
      rows: [
        { shipmentId: "S1", [c.tracking]: "TRK-0001", eventType: "DELIVERED" },
        { shipmentId: "S2", [c.tracking]: "TRK-0002", eventType: "DELIVERED" },
        { shipmentId: "S3", [c.tracking]: "TRK-0003", eventType: "IN_TRANSIT" },
      ],
    },
    { table: `${DEMO_SPACE}.${n.configTable}`, rows: [{ PARAM: "ROUTE", VALUE: "R1" }] },
  ],
  expect: [
    {
      checkpoint: `${DEMO_SPACE}.${n.cleansedView}`,
      assertions: [
        { type: "row_count", equals: 2 },
        { type: "unique", columns: ["shipmentId"] },
      ],
    },
    {
      checkpoint: `${DEMO_SPACE}.${n.output}`,
      assertions: [
        { type: "row_count", equals: 1 },
        { type: "rows_equal", key: ["routeSegmentId"], rows: [{ routeSegmentId: "R1", deliveredShipments: 2 }] },
      ],
    },
  ],
});
/** What each check of DEMO_SCENARIO gives back, in order. */
const DEMO_SCENARIO_DETAILS = ["2 rows", "every value appears once", "1 row", "the 1 row expected"];
/** And in the suite's run, where the output counts all three shipments: the runner's words for that (compareRows). */
const DEMO_BROKEN_DETAIL = '1 different: routeSegmentId "R1": deliveredShipments 3, 2 expected';

/** A made-up value hash: the snapshot stores min and max only as hashes. */
const hash = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("|")).digest("hex");

const text = (name: string, rows: number, distinct: number, version: number): ColumnMeasures => ({
  name,
  dataType: "NVARCHAR",
  nonNull: rows,
  distinct,
  minHash: hash(name, "min"),
  maxHash: hash(name, "max", version),
});
const number = (name: string, dataType: string, rows: number, distinct: number, sum: string, sumScale: number): ColumnMeasures => ({
  name,
  dataType,
  nonNull: rows,
  distinct,
  minHash: hash(name, "min"),
  maxHash: hash(name, "max"),
  sum,
  sumHash: null,
  sumScale,
});

/** What each table and view measures in the first snapshot (version 1) and the second (version 2). */
function measures(technicalName: string, version: 1 | 2): { rows: number; columns: ColumnMeasures[] } | undefined {
  const events = version === 1 ? 48210 : 49875;
  const delivered = version === 1 ? 41022 : 42390;
  switch (technicalName) {
    case n.rawTable:
      return {
        rows: events,
        columns: [
          text("shipmentId", events, delivered, version),
          text(c.tracking, events, delivered, version),
          { name: c.window, dataType: "TIMESTAMP", nonNull: events - 120, distinct: 3650, minHash: hash(c.window, "min"), maxHash: hash(c.window, "max", version) },
          text("eventType", events, 6, 1),
        ],
      };
    case n.cleansedView:
      return {
        rows: delivered,
        columns: [
          text("shipmentId", delivered, delivered, version),
          text(c.tracking, delivered, delivered, version),
          { name: c.window, dataType: "TIMESTAMP", nonNull: delivered, distinct: 3610, minHash: hash(c.window, "min"), maxHash: hash(c.window, "max", version) },
        ],
      };
    case n.enrichedTable:
      return {
        rows: delivered,
        columns: [
          text("shipmentId", delivered, delivered, version),
          text("routeSegmentId", delivered, 12, 1),
          number(c.share, "DECIMAL", delivered, 40, version === 1 ? "20511.000000" : "21195.000000", 6),
          number("deliveryDays", "INTEGER", delivered, 9, String(delivered * 2), 0),
          ...(version === 2 ? [number(c.added, "INTEGER", delivered, 4, "1210", 0)] : []),
        ],
      };
    case n.configTable:
      return { rows: 12, columns: [text("PARAM", 12, 1, 1), text("VALUE", 12, 12, 1)] };
    case n.output:
      return {
        rows: 12,
        columns: [
          text("routeSegmentId", 12, 12, 1),
          number("deliveredShipments", "BIGINT", 12, 12, String(delivered), 0),
          number(c.share, "DECIMAL", 12, 12, version === 1 ? "20511.000000" : "21195.000000", 6),
        ],
      };
    default:
      return undefined; // a flow: not measurable
  }
}

/**
 * Loads the demo into an account as a new tenant without a Datasphere URL,
 * like an imported scan: nothing is ever sent to a tenant. Refuses when the
 * account already has it. On a failure, removes what it added.
 */
export async function loadDemo(
  db: Db,
  accountId: string,
): Promise<{ tenant: Tenant; scan: Scan; pipeline: PipelineDefinition; snapshots: Snapshot[]; scenarioRun: ScenarioRun; suite: ScenarioSuite; signOff: SignOff | null }> {
  if (await findTenantByName(db, accountId, DEMO_TENANT)) throw new Error(`The account already has the tenant "${DEMO_TENANT}". To load it again, delete it from its Home first.`);
  const tenant = await createTenant(db, { accountId, name: DEMO_TENANT, host: null });
  try {
    const graph = graphFromRaw(DEMO_RAW, [DEMO_SPACE]);
    const scan = await saveScanResult(db, (await createScan(db, tenant.id, [DEMO_SPACE], "import")).id, DEMO_RAW, graph);
    const output = { space: DEMO_SPACE, technicalName: n.output };
    const pipeline = await createPipeline(db, { tenantId: tenant.id, name: "Delivered shipments (demo)", output, excludeWriters: [] });
    await createPipeline(db, { tenantId: tenant.id, name: BUSY_PIPELINE_NAME, output: { space: DEMO_SPACE, technicalName: BUSY_OUTPUT }, excludeWriters: [] });
    const { steps } = buildPipeline(graph, output);
    const definitionHashes = new Map(graph.nodes.map((node) => [refKey(node), node.definitionHash]));

    const snapshots: Snapshot[] = [];
    for (const version of [1, 2] as const) {
      const snapshot = await createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null, scheduled: version === 2 });
      await startSnapshot(db, snapshot.id, scan.id);
      for (const [position, step] of steps.entries()) {
        const measured = measures(step.technicalName, version);
        await saveSnapshotObject(db, snapshot.id, position, {
          space: step.space,
          technicalName: step.technicalName,
          type: step.type,
          definitionHash: definitionHashes.get(refKey(step)) ?? null,
          status: measured ? "measured" : "not_measurable",
          reason: measured ? null : "process",
          rows: measured?.rows ?? null,
          columns: measured?.columns ?? null,
          tookMs: measured ? 40 + position * 15 : null,
        });
      }
      await finishSnapshot(db, snapshot.id, { status: "succeeded" });
      snapshots.push((await getSnapshot(db, snapshot.id))!);
    }
    const [cron, timeZone] = ["30 7 * * 1-5", "Europe/Brussels"];
    await setSchedule(db, { pipelineId: pipeline.id, cron, timeZone, nextRunAt: nextRun(cron, timeZone, new Date()), updatedBy: null });
    const [previous, current] = await Promise.all(snapshots.map((s) => getSnapshotDetails(db, s.id)));
    const reasons = alertReasons({ previous, current: current!, output, rowDropPercent: DEFAULT_ROW_DROP_PERCENT });
    await saveSnapshotAlert(db, current!.id, { reasons, comparedWith: previous!.id, status: "no_watchers" });
    snapshots[1] = (await getSnapshot(db, current!.id))!;

    const scenario = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: DEMO_SCENARIO, createdBy: null });
    const plan = planScenario(graph, buildPipeline(graph, output), DEMO_SCENARIO); // compiles only: nothing is sent anywhere
    const run = await createScenarioRun(db, scenario, null);
    await startScenarioRun(db, run.id, scan.id);
    await finishScenarioRun(db, run.id, {
      status: "passed",
      steps: stepNotes(plan.simulation),
      checks: plan.checks.map((check, i) => ({ checkpoint: check.checkpoint, label: check.label, status: "pass", detail: DEMO_SCENARIO_DETAILS[i] })),
    });
    const scenarioRun = (await getScenarioRun(db, run.id))!;

    // All scenarios run by hand, which passed, and the account's first admin approving the results.
    const passing = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
    await startScenarioSuite(db, passing.id);
    for (const id of await suiteRunIds(db, passing.id)) {
      await startScenarioRun(db, id, scan.id);
      await finishScenarioRun(db, id, { status: "passed", steps: stepNotes(plan.simulation), checks: scenarioRun.checks ?? [] });
    }
    await finishScenarioSuite(db, passing.id);
    const admin = (await listMembers(db, accountId)).find((m) => m.role === "admin");
    const signOff = admin
      ? await createSignOff(db, { tenantId: tenant.id, pipelineId: pipeline.id, verdict: "approved", comment: "Totals match the carrier's own count (demo).", userId: admin.userId })
      : null;

    const flow = steps.find((step) => step.technicalName === n.enrichFlow)!;
    const changed = [{ space: flow.space, technicalName: flow.technicalName, type: flow.type, change: "definition" as const }];
    const created = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "scan", scanId: scan.id, changed, requestedBy: null });
    await startScenarioSuite(db, created.id);
    const [suiteRunId] = await suiteRunIds(db, created.id);
    await startScenarioRun(db, suiteRunId, scan.id);
    const checks = plan.checks.map((check, i) => {
      const broken = i === plan.checks.length - 1;
      return { checkpoint: check.checkpoint, label: check.label, status: broken ? ("fail" as const) : ("pass" as const), detail: broken ? DEMO_BROKEN_DETAIL : DEMO_SCENARIO_DETAILS[i] };
    });
    await finishScenarioRun(db, suiteRunId, { status: "failed", steps: stepNotes(plan.simulation), checks });
    await finishScenarioSuite(db, created.id);
    const failedChecks = checks.filter((c) => c.status === "fail").map((c) => c.label);
    await saveScenarioAlert(db, created.id, { broken: [{ scenarioId: scenario.id, runId: suiteRunId, name: scenario.name, status: "failed", failedChecks }], status: "no_watchers" });
    const suite = (await getScenarioSuite(db, created.id))!;

    // The Audit page's story of the demo, as if the account's first admin had set it up by hand.
    if (admin) {
      const onTenant = { kind: "tenant" as const, id: tenant.id, name: tenant.name };
      const onPipeline = { kind: "pipeline" as const, id: pipeline.id, name: pipeline.name, tenantId: tenant.id };
      const events: [string, typeof onTenant | typeof onPipeline | null, Record<string, unknown> | null][] = [
        ["POST /tenants", null, { name: tenant.name, host: null }],
        ["POST /tenants/:id/pipelines", onTenant, { name: pipeline.name, output: refKey(output) }],
        ["PUT /pipelines/:id/schedule", onPipeline, { cron, timeZone }],
        ["POST /pipelines/:id/scenarios", onPipeline, { name: scenario.name, kind: DEMO_SCENARIO.kind }],
        ["POST /pipelines/:id/scenario-suites", onPipeline, null],
        ["POST /pipelines/:id/signoffs", onPipeline, { verdict: "approved", comment: signOff?.comment ?? "" }],
      ];
      for (const [action, target, detail] of events) await recordAuditEvent(db, { accountId, userId: admin.userId, action, target, detail, ip: null });
    }
    return { tenant, scan, pipeline, snapshots, scenarioRun, suite, signOff };
  } catch (e) {
    await deleteTenant(db, tenant.id);
    throw e;
  }
}
