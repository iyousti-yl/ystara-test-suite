import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createTenant,
  finishSnapshot,
  getDatabaseUserLogin,
  recordDatabaseCheck,
  saveScanResult,
  saveSnapshotObject,
  setDatabaseUser,
  startSnapshot,
  type Db,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { JOBS } from "@ystara/shared";
import { testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { buildServer } from "../server.js";

// Synthetic space: V_OUT reads LT_DATA.
const RAW: RawObject[] = [
  { space: "S", kind: "local-tables", technicalName: "LT_DATA", definition: { definitions: { LT_DATA: { kind: "entity" } } } },
  { space: "S", kind: "views", technicalName: "V_OUT", definition: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "LT_DATA"' } } } },
];
const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
let coordinator: TestUser;
let viewer: TestUser;
let stranger: TestUser;
const sent: { name: string; data: object }[] = [];

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async (name, data) => sent.push({ name, data }) }, secrets: testSecrets }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
  coordinator = await testUser(db, { account: "Customer", email: "coordinator@customer.example.com", role: "test_coordinator" });
  viewer = await testUser(db, { account: "Customer", email: "viewer@customer.example.com", role: "viewer" });
  stranger = await testUser(db, { account: "Elsewhere", email: "admin@elsewhere.example.com", role: "admin" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST", url: string, as: TestUser) => app.inject({ method, url: `/api${url}`, headers: { cookie: as.cookie } });

/** A scanned tenant with a saved pipeline for V_OUT; with `visible`, a checked database user of S that sees those objects. */
async function pipelineOf(name: string, visible?: string[]) {
  const tenant = await createTenant(db, { accountId: admin.accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const scan = await createScan(db, tenant.id, ["S"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
  if (visible) {
    await setDatabaseUser(db, { tenantId: tenant.id, space: "S", host, user: "S#SYNTH", sealedPassword: "v1.sealed", updatedBy: null });
    await recordDatabaseCheck(db, (await getDatabaseUserLogin(db, tenant.id, "S"))!, { visible: visible.map((v) => ({ name: v, type: "VIEW" as const })) });
  }
  return createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
}

describe("snapshots", () => {
  it("are taken by those who run tests, queued for the worker, and read by everyone in the account", async () => {
    const pipeline = await pipelineOf("Measured", ["V_OUT"]);
    sent.length = 0;
    expect((await call("POST", `/pipelines/${pipeline.id}/snapshots`, viewer)).statusCode).toBe(403);
    const res = await call("POST", `/pipelines/${pipeline.id}/snapshots`, coordinator);
    expect(res.statusCode).toBe(202);
    const snapshot = res.json();
    expect(snapshot).toMatchObject({ pipelineId: pipeline.id, status: "queued", counts: { measured: 0, notMeasurable: 0, failed: 0 } });
    expect(sent).toEqual([{ name: JOBS.snapshot, data: { snapshotId: snapshot.id } }]);

    // As the worker leaves it.
    await startSnapshot(db, snapshot.id, null);
    await saveSnapshotObject(db, snapshot.id, 0, { space: "S", technicalName: "LT_DATA", type: "local_table", definitionHash: "h0", status: "not_measurable", reason: "not-visible", rows: null, columns: null, tookMs: null });
    await saveSnapshotObject(db, snapshot.id, 1, {
      space: "S",
      technicalName: "V_OUT",
      type: "sql_view",
      definitionHash: "h1",
      status: "measured",
      reason: null,
      rows: 3,
      columns: [{ name: "DAY", dataType: "DATE", nonNull: 3, distinct: 3, minHash: "aa", maxHash: "bb" }],
      tookMs: 40,
    });
    await finishSnapshot(db, snapshot.id, { status: "succeeded" });

    const list = await call("GET", `/pipelines/${pipeline.id}/snapshots`, viewer);
    expect(list.json()).toMatchObject([{ id: snapshot.id, status: "succeeded", counts: { measured: 1, notMeasurable: 1, failed: 0 } }]);
    const details = await call("GET", `/snapshots/${snapshot.id}`, viewer);
    expect(details.json().objects.map((o: { technicalName: string; status: string }) => [o.technicalName, o.status])).toEqual([
      ["LT_DATA", "not_measurable"],
      ["V_OUT", "measured"],
    ]);
  });

  it("are refused when no step can be measured, or the tenant has no scan", async () => {
    sent.length = 0;
    for (const [pipeline, why] of [
      [await pipelineOf("No database user"), /^There is no database user for space S yet/],
      [await pipelineOf("Output not exposed", ["V_OTHER"]), /none is exposed for consumption/],
    ] as const) {
      const res = await call("POST", `/pipelines/${pipeline.id}/snapshots`, admin);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(why);
    }
    const imported = await createTenant(db, { accountId: admin.accountId, name: "Imported only", host: null });
    const scan = await createScan(db, imported.id, ["S"], "import");
    await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
    const fromImport = await createPipeline(db, { tenantId: imported.id, name: "From an import", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
    expect((await call("POST", `/pipelines/${fromImport.id}/snapshots`, admin)).json().error).toMatch(/^This tenant only has imported scans/);
    const tenant = await createTenant(db, { accountId: admin.accountId, name: "Never scanned", host: "https://synthetic.eu10.hcs.cloud.sap" });
    const early = await createPipeline(db, { tenantId: tenant.id, name: "Early", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
    expect((await call("POST", `/pipelines/${early.id}/snapshots`, admin)).json().error).toMatch(/no successful scan/);
    expect(sent).toEqual([]);
  });

  it("are another account's business: 404, as if the pipeline didn't exist", async () => {
    const pipeline = await pipelineOf("Private", ["V_OUT"]);
    const snapshot = (await call("POST", `/pipelines/${pipeline.id}/snapshots`, admin)).json();
    expect((await call("GET", `/pipelines/${pipeline.id}/snapshots`, stranger)).statusCode).toBe(404);
    expect((await call("POST", `/pipelines/${pipeline.id}/snapshots`, stranger)).statusCode).toBe(404);
    expect((await call("GET", `/snapshots/${snapshot.id}`, stranger)).statusCode).toBe(404);
    expect((await call("GET", "/snapshots/not-an-id", admin)).statusCode).toBe(400);
  });
});
