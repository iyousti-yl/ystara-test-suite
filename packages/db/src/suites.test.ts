import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScenarioYaml } from "@ystara/shared";
import { createAccount } from "./accounts.js";
import { saveScenarioAlert, saveScenarioAlertTeams } from "./alerts.js";
import type { Db } from "./db.js";
import { createPipeline } from "./pipelines.js";
import { createScan } from "./scans.js";
import { createScenario, createScenarioRun, finishScenarioRun, getScenarioRun, startScenarioRun } from "./scenarios.js";
import {
  createScenarioSuite,
  finishScenarioSuite,
  getScenarioSuite,
  hasUnfinishedSuite,
  lastScenarioScanId,
  listScenarioSuites,
  startScenarioSuite,
  statusesBeforeSuite,
  suiteRunIds,
  suiteRunResults,
} from "./suites.js";
import { createTenant } from "./tenants.js";
import { createTestDb } from "./testing.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const spec = (name: string) =>
  parseScenarioYaml(`
name: ${name}
kind: golden
pipeline: SALES.V_REGION_OUT
fixtures:
  - table: LT_ORDERS
    rows: [{ ORDER_ID: "1" }]
expect:
  - checkpoint: V_REGION_OUT
    assertions: [{ type: row_count, equals: 1 }]
`);

async function newPipeline(name: string, scenarios: string[]) {
  const account = await createAccount(db, `Account of ${name}`);
  const tenant = await createTenant(db, { accountId: account.id, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "SALES", technicalName: "V_REGION_OUT" }, excludeWriters: [] });
  const stored = [];
  for (const s of scenarios) stored.push(await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec(s), createdBy: null }));
  return { tenant, pipeline, scenarios: stored };
}

describe("suites", () => {
  it("queue a run of every scenario the pipeline has, by name, and finish from what their runs gave", async () => {
    const { tenant, pipeline, scenarios } = await newPipeline("Suites", ["closed orders", "Region totals"]);
    const suite = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
    expect(suite).toMatchObject({ cause: "manual", status: "queued", total: 2, passed: null, changed: [], alert: null, pipelineName: "Suites" });
    expect(suite.runs.map((r) => [r.scenarioName, r.status])).toEqual([
      ["closed orders", "queued"],
      ["Region totals", "queued"],
    ]);
    expect((await getScenarioRun(db, suite.runs[0]!.id))?.suiteId).toBe(suite.id);
    expect(await suiteRunIds(db, suite.id)).toEqual(suite.runs.map((r) => r.id));
    expect(await hasUnfinishedSuite(db, pipeline.id, new Date(0))).toBe(true);

    expect(await startScenarioSuite(db, suite.id)).toBe(true);
    expect(await startScenarioSuite(db, suite.id)).toBe(false); // taken once
    const scan = await createScan(db, tenant.id, ["SALES"]);
    for (const [i, id] of suite.runs.map((r) => r.id).entries()) {
      await startScenarioRun(db, id, scan.id);
      await finishScenarioRun(db, id, { status: i === 0 ? "failed" : "passed", checks: [{ checkpoint: "V_REGION_OUT", label: "row_count = 1", status: i === 0 ? "fail" : "pass", detail: "" }] });
    }
    await finishScenarioSuite(db, suite.id);
    expect(await getScenarioSuite(db, suite.id)).toMatchObject({ status: "failed", passed: 1, total: 2 });
    expect(await hasUnfinishedSuite(db, pipeline.id, new Date(0))).toBe(false);
    expect(await lastScenarioScanId(db, pipeline.id)).toBe(scan.id);
    expect((await suiteRunResults(db, suite.id)).map((r) => [r.scenarioName, r.status, r.checks?.[0]?.status])).toEqual([
      ["closed orders", "failed", "fail"],
      ["Region totals", "passed", "pass"],
    ]);
    expect((await listScenarioSuites(db, pipeline.id)).map((s) => s.id)).toEqual([suite.id]);
    expect(scenarios).toHaveLength(2);
  });

  it("that can't start mark their queued runs as errors", async () => {
    const { tenant, pipeline } = await newPipeline("Stopped", ["one"]);
    const suite = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
    await finishScenarioSuite(db, suite.id, "No database user");
    const done = await getScenarioSuite(db, suite.id);
    expect(done).toMatchObject({ status: "error", error: "No database user", passed: 0, total: 1 });
    expect(done?.runs[0]).toMatchObject({ status: "error", error: "No database user" });

    const empty = await newPipeline("Empty", []);
    const none = await createScenarioSuite(db, { tenantId: empty.tenant.id, pipelineId: empty.pipeline.id, cause: "manual", requestedBy: null });
    await finishScenarioSuite(db, none.id);
    expect(await getScenarioSuite(db, none.id)).toMatchObject({ status: "failed", total: 0, runs: [] });
  });

  it("know each scenario's run before them, and keep their alert", async () => {
    const { tenant, pipeline, scenarios } = await newPipeline("Before", ["a", "b", "c"]);
    const [a, b] = scenarios;
    const earlier = await createScenarioRun(db, a!, null);
    await finishScenarioRun(db, earlier.id, { status: "passed", checks: [] });
    const failing = await createScenarioRun(db, b!, null);
    await finishScenarioRun(db, failing.id, { status: "failed", checks: [] });
    await new Promise((r) => setTimeout(r, 5)); // requested after them
    const suite = await createScenarioSuite(db, {
      tenantId: tenant.id,
      pipelineId: pipeline.id,
      cause: "scan",
      changed: [{ space: "SALES", technicalName: "V_REGION_OUT", type: "sql_view", change: "definition" }],
      requestedBy: null,
    });
    expect(suite.changed).toEqual([{ space: "SALES", technicalName: "V_REGION_OUT", type: "sql_view", change: "definition" }]);
    // c never ran before; the suite's own runs don't count.
    expect(Object.fromEntries(await statusesBeforeSuite(db, suite.id))).toEqual({ [a!.id]: "passed", [b!.id]: "failed" });

    const broken = [{ scenarioId: a!.id, runId: suite.runs[0]!.id, name: "a", status: "failed" as const, failedChecks: ["row_count = 1"] }];
    await saveScenarioAlert(db, suite.id, { broken, status: "sending" });
    await saveScenarioAlertTeams(db, suite.id, { status: "failed", error: "Teams refused the post (HTTP 404)." });
    await saveScenarioAlert(db, suite.id, { broken, status: "sent", recipients: 2 });
    expect((await getScenarioSuite(db, suite.id))?.alert).toMatchObject({
      broken,
      status: "sent",
      recipients: 2,
      teams: { status: "failed", error: "Teams refused the post (HTTP 404)." },
      sentAt: expect.any(Date),
    });
  });
});
