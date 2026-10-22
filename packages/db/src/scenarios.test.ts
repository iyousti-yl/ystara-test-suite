import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScenarioYaml } from "@ystara/shared";
import { createAccount } from "./accounts.js";
import type { Db } from "./db.js";
import { createPipeline, deletePipeline } from "./pipelines.js";
import {
  createScenario,
  createScenarioRun,
  deleteScenario,
  finishScenarioRun,
  getScenario,
  getScenarioRun,
  listScenarioRuns,
  listScenarios,
  ScenarioNameTaken,
  startScenarioRun,
  updateScenario,
} from "./scenarios.js";
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
    rows: [{ ORDER_ID: "1", AMOUNT: 10.5 }]
expect:
  - checkpoint: V_REGION_OUT
    assertions: [{ type: row_count, equals: 1 }]
`);

async function newPipeline(name: string) {
  const account = await createAccount(db, `Account of ${name}`);
  const tenant = await createTenant(db, { accountId: account.id, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "SALES", technicalName: "V_REGION_OUT" }, excludeWriters: [] });
  return { tenant, pipeline };
}

describe("scenarios", () => {
  it("are stored per pipeline with a name unique there, and keep their spec as it was saved", async () => {
    const { tenant, pipeline } = await newPipeline("Production");
    const other = await newPipeline("Other");
    const first = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec("Region totals"), createdBy: null });
    expect(first).toMatchObject({ name: "Region totals", pipelineId: pipeline.id, lastRun: null, updatedBy: null });
    expect(first.spec.fixtures[0].rows).toEqual([{ ORDER_ID: "1", AMOUNT: 10.5 }]);
    await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec("closed orders"), createdBy: null });
    await expect(createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec("Region totals"), createdBy: null })).rejects.toThrow(ScenarioNameTaken);
    // Another pipeline may use the same name.
    await createScenario(db, { tenantId: other.tenant.id, pipelineId: other.pipeline.id, spec: spec("Region totals"), createdBy: null });
    expect((await listScenarios(db, pipeline.id)).map((s) => s.name)).toEqual(["closed orders", "Region totals"]);

    const renamed = await updateScenario(db, first.id, { spec: spec("Region totals, renamed"), updatedBy: null });
    expect(renamed?.name).toBe("Region totals, renamed");
    await expect(updateScenario(db, first.id, { spec: spec("closed orders"), updatedBy: null })).rejects.toThrow(ScenarioNameTaken);
    expect(await updateScenario(db, "00000000-0000-4000-8000-000000000000", { spec: spec("x"), updatedBy: null })).toBeUndefined();
  });

  it("have runs that keep the scenario as it was asked for, go from queued to running to a result, and show the latest on the scenario", async () => {
    const { tenant, pipeline } = await newPipeline("Runs");
    const scenario = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec("Region totals"), createdBy: null });
    const first = await createScenarioRun(db, scenario, null);
    expect(first).toMatchObject({ status: "queued", scenarioName: "Region totals", pipelineName: "Runs", passed: null, total: null, checks: null });
    // Changing the scenario afterwards doesn't change what the run runs.
    await updateScenario(db, scenario.id, { spec: spec("Region totals 2"), updatedBy: null });
    expect((await getScenarioRun(db, first.id))?.spec.name).toBe("Region totals");

    expect(await startScenarioRun(db, first.id, null)).toBe(true);
    expect(await startScenarioRun(db, first.id, null)).toBe(false); // another worker has it
    await finishScenarioRun(db, first.id, {
      status: "failed",
      steps: [{ space: "SALES", technicalName: "LT_ORDERS", type: "local_table", note: "1 test row given" }],
      checks: [
        { checkpoint: "V_REGION_OUT", label: "row_count = 1", status: "pass", detail: "1 row" },
        { checkpoint: "V_REGION_OUT", label: "unique REGION", status: "fail", detail: "1 value appears more than once" },
      ],
    });
    expect(await getScenarioRun(db, first.id)).toMatchObject({ status: "failed", passed: 1, total: 2, error: null });

    const second = await createScenarioRun(db, (await getScenario(db, scenario.id))!, null);
    await finishScenarioRun(db, second.id, { status: "error", error: "This tenant has no successful scan yet" });
    expect((await listScenarioRuns(db, scenario.id)).map((r) => [r.status, r.passed])).toEqual([
      ["error", null],
      ["failed", 1],
    ]);
    expect((await getScenario(db, scenario.id))?.lastRun).toMatchObject({ id: second.id, status: "error" });
  });

  it("go with their runs when the scenario or its pipeline is deleted", async () => {
    const { tenant, pipeline } = await newPipeline("Deleted");
    const a = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec("A"), createdBy: null });
    const b = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: spec("B"), createdBy: null });
    const run = await createScenarioRun(db, a, null);
    expect(await deleteScenario(db, a.id)).toBe(true);
    expect(await getScenarioRun(db, run.id)).toBeUndefined();
    await deletePipeline(db, pipeline.id);
    expect(await getScenario(db, b.id)).toBeUndefined();
  });
});
