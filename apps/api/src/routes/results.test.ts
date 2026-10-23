import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createScenario,
  createScenarioRun,
  createScenarioSuite,
  createSnapshot,
  createTenant,
  finishScenarioRun,
  finishScenarioSuite,
  finishSnapshot,
  saveScanResult,
  saveSnapshotObject,
  startSnapshot,
  suiteRunIds,
  type Db,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { pipelineHealth, ScenarioSpec, type HistoryEvent, type PipelineDefinition, type PipelineReport, type PipelineSummary, type SignOffState } from "@ystara/shared";
import { testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { buildServer } from "../server.js";

// Synthetic space: V_OUT reads LT_DATA.
const rawWith = (query: string): RawObject[] => [
  { space: "S", kind: "local-tables", technicalName: "LT_DATA", definition: { definitions: { LT_DATA: { kind: "entity" } } } },
  { space: "S", kind: "views", technicalName: "V_OUT", definition: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": query } } } },
];
const RAW = rawWith('SELECT * FROM "LT_DATA"');
const spec = ScenarioSpec.parse({
  name: "Open rows",
  kind: "golden",
  pipeline: "S.V_OUT",
  fixtures: [{ table: "S.LT_DATA", rows: [{ ID: "1" }] }],
  expect: [{ checkpoint: "S.V_OUT", assertions: [{ type: "row_count", equals: 1 }] }],
});

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
let coordinator: TestUser;
let developer: TestUser;
let viewer: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async () => {} }, secrets: testSecrets }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
  coordinator = await testUser(db, { account: "Customer", email: "coordinator@customer.example.com", role: "test_coordinator" });
  developer = await testUser(db, { account: "Customer", email: "developer@customer.example.com", role: "developer" });
  viewer = await testUser(db, { account: "Customer", email: "viewer@customer.example.com", role: "viewer" });
  stranger = await testUser(db, { account: "Elsewhere", email: "admin@elsewhere.example.com", role: "admin" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST", url: string, as: TestUser, payload?: object) => app.inject({ method, url: `/api${url}`, headers: { cookie: as.cookie }, payload });

/** A tenant with a saved pipeline for V_OUT, scanned unless `scanned` is false. */
async function pipelineOf(name: string, scanned = true): Promise<PipelineDefinition> {
  const tenant = await createTenant(db, { accountId: admin.accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  if (scanned) await scan(tenant.id, RAW);
  return createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
}

async function scan(tenantId: string, raw: RawObject[]) {
  const s = await createScan(db, tenantId, ["S"], "import");
  await saveScanResult(db, s.id, raw, graphFromRaw(raw, ["S"]));
  return s.id;
}

/** A successful snapshot that counted `rows` rows in V_OUT. */
async function snapshotOf(pipeline: PipelineDefinition, rows: number) {
  const snapshot = await createSnapshot(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: null });
  await startSnapshot(db, snapshot.id, null);
  await saveSnapshotObject(db, snapshot.id, 0, {
    space: "S",
    technicalName: "V_OUT",
    type: "sql_view",
    definitionHash: "h1",
    status: "measured",
    reason: null,
    rows,
    columns: [{ name: "ID", dataType: "NVARCHAR", nonNull: rows, distinct: rows, minHash: "aa", maxHash: "bb" }],
    tookMs: 10,
  });
  await finishSnapshot(db, snapshot.id, { status: "succeeded" });
  return snapshot.id;
}

/** A finished suite of the pipeline's one scenario, which passed. */
async function suiteOf(pipeline: PipelineDefinition) {
  await createScenario(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, spec: { ...spec, name: `Open rows ${pipeline.name}` }, createdBy: null });
  const suite = await createScenarioSuite(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
  for (const id of await suiteRunIds(db, suite.id)) {
    await finishScenarioRun(db, id, { status: "passed", checks: [{ checkpoint: "S.V_OUT", label: "row_count = 1", status: "pass", detail: "1 row" }] });
  }
  await finishScenarioSuite(db, suite.id);
  return suite.id;
}

describe("signing off a pipeline", () => {
  it("is for admins and test coordinators, and covers a scan and a suite or a snapshot", async () => {
    const unscanned = await pipelineOf("Unscanned", false);
    expect((await call("POST", `/pipelines/${unscanned.id}/signoffs`, coordinator, { verdict: "approved" })).statusCode).toBe(409);

    const pipeline = await pipelineOf("Signed");
    const url = `/pipelines/${pipeline.id}/signoffs`;
    expect((await call("POST", url, coordinator, { verdict: "approved" })).json().error).toMatch(/scenarios or take a snapshot first/);
    const snapshotId = await snapshotOf(pipeline, 3);

    expect((await call("POST", url, developer, { verdict: "approved" })).statusCode).toBe(403);
    expect((await call("POST", url, viewer, { verdict: "approved" })).statusCode).toBe(403);
    expect((await call("POST", url, stranger, { verdict: "approved" })).statusCode).toBe(404);
    expect((await call("POST", url, coordinator, { verdict: "rejected", comment: "  " })).statusCode).toBe(400);
    expect((await call("POST", url, coordinator, { verdict: "maybe" })).statusCode).toBe(400);

    const approved = await call("POST", url, coordinator, { verdict: "approved", comment: "Checked with the business" });
    expect(approved.statusCode).toBe(201);
    expect(approved.json()).toMatchObject({ verdict: "approved", comment: "Checked with the business", signedBy: coordinator.email, suite: null, snapshot: { id: snapshotId } });

    const state: SignOffState = (await call("GET", url, viewer)).json();
    expect(state.latest).toMatchObject({ id: approved.json().id, verdict: "approved" });
    expect(state.changedSince).toEqual([]);
    expect(state.basis.snapshot?.id).toBe(snapshotId);
    expect(state.all).toHaveLength(1);
    expect((await call("GET", url, stranger)).statusCode).toBe(404);

    // A later sign-off takes over, and covers the suite that ran since.
    const suiteId = await suiteOf(pipeline);
    const rejected = await call("POST", url, admin, { verdict: "rejected", comment: "Totals are off" });
    expect(rejected.json()).toMatchObject({ verdict: "rejected", signedBy: admin.email, suite: { id: suiteId, status: "passed", passed: 1, total: 1 } });
    const after: SignOffState = (await call("GET", url, viewer)).json();
    expect(after.latest?.verdict).toBe("rejected");
    expect(after.all.map((s) => s.verdict)).toEqual(["rejected", "approved"]);
  });

  it("says which steps a later scan changed since", async () => {
    const pipeline = await pipelineOf("Changed");
    await snapshotOf(pipeline, 1);
    await call("POST", `/pipelines/${pipeline.id}/signoffs`, coordinator, { verdict: "approved" });
    await scan(pipeline.tenantId, rawWith('SELECT * FROM "LT_DATA" WHERE 1 = 1'));
    const state: SignOffState = (await call("GET", `/pipelines/${pipeline.id}/signoffs`, viewer)).json();
    expect(state.changedSince).toEqual([{ space: "S", technicalName: "V_OUT", type: "sql_view", change: "definition" }]);
    const board: PipelineSummary[] = (await call("GET", `/tenants/${pipeline.tenantId}/pipeline-summaries`, viewer)).json();
    expect(board.find((s) => s.pipelineId === pipeline.id)?.signOff).toMatchObject({ verdict: "approved", outdated: true, outdatedBy: "scan" });
    expect(state.outdatedBy).toBe("scan");
  });

  it("says when a result that came in after an approval contradicts it", async () => {
    const pipeline = await pipelineOf("Emptied");
    await snapshotOf(pipeline, 4);
    await call("POST", `/pipelines/${pipeline.id}/signoffs`, coordinator, { verdict: "approved" });
    await db.query("update pipeline_signoffs set signed_at = now() - interval '1 minute' where pipeline_id = $1", [pipeline.id]);
    const before: SignOffState = (await call("GET", `/pipelines/${pipeline.id}/signoffs`, viewer)).json();
    expect(before.outdatedBy).toBeNull();

    await snapshotOf(pipeline, 0); // the output is empty now
    const after: SignOffState = (await call("GET", `/pipelines/${pipeline.id}/signoffs`, viewer)).json();
    expect(after.outdatedBy).toBe("result");
    const board: PipelineSummary[] = (await call("GET", `/tenants/${pipeline.tenantId}/pipeline-summaries`, viewer)).json();
    const row = board.find((s) => s.pipelineId === pipeline.id)!;
    expect(row.signOff).toMatchObject({ verdict: "approved", outdated: true, outdatedBy: "result" });
    expect(pipelineHealth(row).state).toBe("empty");
  });
});

describe("a pipeline's history", () => {
  it("lists suites, runs on their own, snapshots with the output's rows, and sign-offs, newest first", async () => {
    const pipeline = await pipelineOf("History");
    await snapshotOf(pipeline, 5);
    const suiteId = await suiteOf(pipeline);
    const scenario = await createScenario(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, spec: { ...spec, name: "On its own" }, createdBy: null });
    const run = await createScenarioRun(db, scenario, null);
    await finishScenarioRun(db, run.id, { status: "failed", checks: [{ checkpoint: "S.V_OUT", label: "row_count = 1", status: "fail", detail: "2 rows" }] });
    await snapshotOf(pipeline, 7);
    await call("POST", `/pipelines/${pipeline.id}/signoffs`, coordinator, { verdict: "approved", comment: "=SUM(A1)" });

    const { events }: { events: HistoryEvent[] } = (await call("GET", `/pipelines/${pipeline.id}/history`, viewer)).json();
    expect(events.map((e) => e.kind)).toEqual(["signoff", "snapshot", "run", "suite", "snapshot"]);
    expect(events[1]).toMatchObject({ kind: "snapshot", status: "succeeded", outputRows: 7, alert: false, scheduled: false });
    expect(events[2]).toMatchObject({ kind: "run", scenarioName: "On its own", status: "failed", passed: 0, total: 1 });
    expect(events[3]).toMatchObject({ kind: "suite", id: suiteId, cause: "manual", status: "passed", passed: 1, total: 1 });
    expect((await call("GET", `/pipelines/${pipeline.id}/history`, stranger)).statusCode).toBe(404);

    const csv = await call("GET", `/pipelines/${pipeline.id}/history.csv`, viewer);
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="ystara-history-History.csv"');
    const lines = csv.body.split("\r\n");
    expect(lines[0]).toBe("﻿When (UTC),What,Result,Passed,Total,Output rows,By,Comment,ID");
    expect(lines).toHaveLength(7); // the header, 5 events and the final line break
    // A comment that a spreadsheet would run as a formula is kept as text.
    expect(lines[1]).toContain(`,Sign-off,approved,,,,${coordinator.email},'=SUM(A1),`);
    expect(lines[2]).toMatch(/,Snapshot,succeeded,,,7,,,/);
  });

  it("makes one report: steps, the latest sign-off, the suite it covers, the last two snapshots compared, and the history", async () => {
    const pipeline = await pipelineOf("Report");
    await snapshotOf(pipeline, 3);
    const suiteId = await suiteOf(pipeline);
    await snapshotOf(pipeline, 4);
    await call("POST", `/pipelines/${pipeline.id}/signoffs`, coordinator, { verdict: "approved", comment: "Fine" });

    const res = await call("GET", `/pipelines/${pipeline.id}/report`, viewer);
    expect(res.statusCode).toBe(200);
    const report: PipelineReport = res.json();
    expect(report.generatedBy).toBe(viewer.email);
    expect(report.tenant.name).toBe("Report");
    expect(report.steps?.steps.map((s) => s.technicalName)).toEqual(["LT_DATA", "V_OUT"]);
    expect(report.signOff.latest).toMatchObject({ verdict: "approved", comment: "Fine", suite: { id: suiteId } });
    expect(report.signOff.changedSince).toEqual([]);
    expect(report.suite).toMatchObject({ id: suiteId, status: "passed", runs: [{ status: "passed", checks: [{ label: "row_count = 1", status: "pass" }] }] });
    expect(report.comparison).toMatchObject({ verdict: "data_changed", changed: [{ technicalName: "V_OUT", verdict: "data_changed" }] });
    expect(report.history.map((e) => e.kind)).toEqual(["signoff", "snapshot", "suite", "snapshot"]);
    expect((await call("GET", `/pipelines/${pipeline.id}/report`, stranger)).statusCode).toBe(404);
  });
});

describe("the Pipelines board", () => {
  it("gives each pipeline its latest suite, snapshot with the output's rows, schedule, sign-off and watch, for its tenant only", async () => {
    const tested = await pipelineOf("Board tested");
    const tenantId = tested.tenantId;
    const untested = await createPipeline(db, { tenantId, name: "Board untested", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
    const suiteId = await suiteOf(tested);
    const snapshotId = await snapshotOf(tested, 7);
    await call("POST", `/pipelines/${tested.id}/signoffs`, coordinator, { verdict: "approved" });

    const res = await call("GET", `/tenants/${tenantId}/pipeline-summaries`, viewer);
    expect(res.statusCode).toBe(200);
    const [first, second]: PipelineSummary[] = res.json();
    expect(first).toMatchObject({
      pipelineId: tested.id,
      scenarios: 1,
      suite: { id: suiteId, status: "passed", passed: 1, total: 1 },
      snapshot: { id: snapshotId, status: "succeeded", outputRows: 7, alert: null },
      schedule: null,
      signOff: { verdict: "approved", outdated: false },
      watching: false,
    });
    expect(pipelineHealth(first)).toMatchObject({ state: "ok", sentence: "Its one scenario passes." });
    expect(second).toMatchObject({ pipelineId: untested.id, scenarios: 0, suite: null, snapshot: null, signOff: null });
    expect(pipelineHealth(second).state).toBe("untested");

    expect((await call("GET", `/tenants/${tenantId}/pipeline-summaries`, stranger)).statusCode).toBe(404);
  });
});
