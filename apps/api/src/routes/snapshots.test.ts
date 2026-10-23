import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import {
  createPipeline,
  createScan,
  createSnapshot,
  createTenant,
  deletePipeline,
  finishSnapshot,
  getDatabaseUserLogin,
  getSchedule,
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

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, as: TestUser, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: { cookie: as.cookie }, payload });

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
    const twice = await call("POST", `/pipelines/${pipeline.id}/snapshots`, coordinator);
    expect([twice.statusCode, twice.json().error]).toEqual([409, expect.stringMatching(/^A snapshot of this pipeline is still being taken/)]);

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

describe("comparing two snapshots", () => {
  /** A snapshot of V_OUT as the worker leaves it, taken at `at`; "running" leaves it unfinished. */
  async function taken(pipeline: { id: string; tenantId: string }, rows: number, at: string, status: "succeeded" | "failed" | "running" = "succeeded") {
    const snapshot = await createSnapshot(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: null });
    await db.query("update snapshots set requested_at = $2 where id = $1", [snapshot.id, at]);
    await startSnapshot(db, snapshot.id, null);
    await saveSnapshotObject(db, snapshot.id, 0, {
      space: "S",
      technicalName: "V_OUT",
      type: "sql_view",
      definitionHash: "h1",
      status: "measured",
      reason: null,
      rows,
      columns: [{ name: "ID", dataType: "INTEGER", nonNull: rows, distinct: rows, minHash: "01".repeat(32), maxHash: "02".repeat(32), sum: String(rows), sumHash: null, sumScale: 0 }],
      tookMs: 3,
    });
    if (status !== "running") await finishSnapshot(db, snapshot.id, { status, error: status === "failed" ? "A step failed" : undefined });
    return snapshot;
  }

  it("compares the latest two successful ones by default, and any two the reader picks", async () => {
    const pipeline = await pipelineOf("Compared", ["V_OUT"]);
    expect((await call("GET", `/pipelines/${pipeline.id}/compare`, viewer)).statusCode).toBe(409);
    const first = await taken(pipeline, 100, "2026-01-01T10:00:00Z");
    const second = await taken(pipeline, 100, "2026-01-02T10:00:00Z");
    const third = await taken(pipeline, 120, "2026-01-03T10:00:00Z");
    const failed = await taken(pipeline, 90, "2026-01-04T10:00:00Z", "failed");

    const latest = await call("GET", `/pipelines/${pipeline.id}/compare`, viewer);
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      before: { id: second.id },
      after: { id: third.id },
      verdict: "data_changed",
      compared: [{ technicalName: "V_OUT", verdict: "data_changed", rows: { before: 100, after: 120, difference: 20, percent: 20 } }],
    });
    expect(latest.json().before).not.toHaveProperty("objects");
    expect((await call("GET", `/pipelines/${pipeline.id}/compare?from=${first.id}&to=${second.id}`, viewer)).json()).toMatchObject({ verdict: "unchanged" });
    // A failed snapshot keeps what it measured, so it can be picked.
    expect((await call("GET", `/pipelines/${pipeline.id}/compare?from=${third.id}&to=${failed.id}`, viewer)).json()).toMatchObject({ after: { id: failed.id }, verdict: "data_changed" });
  });

  it("refuses an unfinished snapshot, half a pair, and another pipeline's or account's snapshots", async () => {
    const pipeline = await pipelineOf("Compared strictly", ["V_OUT"]);
    const other = await pipelineOf("Other pipeline", ["V_OUT"]);
    const done = await taken(pipeline, 10, "2026-02-01T10:00:00Z");
    const running = await taken(pipeline, 10, "2026-02-02T10:00:00Z", "running");
    const elsewhere = await taken(other, 10, "2026-02-03T10:00:00Z");
    const compare = (query: string, as = admin) => call("GET", `/pipelines/${pipeline.id}/compare${query}`, as);

    expect((await compare(`?from=${done.id}&to=${running.id}`)).json()).toEqual({ error: "A snapshot can be compared once it has finished" });
    expect((await compare(`?from=${done.id}`)).statusCode).toBe(400);
    expect((await compare(`?from=${done.id}&to=not-an-id`)).statusCode).toBe(400);
    expect((await compare(`?from=${done.id}&to=${elsewhere.id}`)).statusCode).toBe(404);
    expect((await compare(`?from=${done.id}&to=${done.id}`, stranger)).statusCode).toBe(404);
  });
});

describe("schedules", () => {
  const weekdays = { cron: "30  7 * * 1-5", timeZone: "Europe/Brussels" };

  it("are set and removed by those who run tests, read by everyone, with the next run worked out", async () => {
    const pipeline = await pipelineOf("Scheduled", ["V_OUT"]);
    const url = `/pipelines/${pipeline.id}/schedule`;
    expect((await call("GET", url, viewer)).json()).toEqual({ schedule: null });
    expect((await call("PUT", url, viewer, weekdays)).statusCode).toBe(403);

    const res = await call("PUT", url, coordinator, weekdays);
    expect(res.statusCode).toBe(200);
    const { schedule } = res.json();
    expect(schedule).toMatchObject({ pipelineId: pipeline.id, cron: "30 7 * * 1-5", timeZone: "Europe/Brussels", updatedBy: coordinator.userId });
    const next = new Date(schedule.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next)).toBe("07:30");
    expect((await call("GET", url, viewer)).json().schedule).toMatchObject({ cron: "30 7 * * 1-5" });

    // Replaced, then removed.
    expect((await call("PUT", url, admin, { cron: "0 6 * * *", timeZone: "UTC" })).json().schedule).toMatchObject({ cron: "0 6 * * *", timeZone: "UTC", updatedBy: admin.userId });
    expect((await call("DELETE", url, viewer)).statusCode).toBe(403);
    expect((await call("DELETE", url, coordinator)).statusCode).toBe(204);
    expect((await call("GET", url, viewer)).json()).toEqual({ schedule: null });
  });

  it("refuse a cron line that isn't a schedule, runs too close together, and a pipeline nothing can be measured in", async () => {
    const pipeline = await pipelineOf("Badly scheduled", ["V_OUT"]);
    const put = (body: object) => call("PUT", `/pipelines/${pipeline.id}/schedule`, admin, body);
    expect((await put({ cron: "30 7 * *", timeZone: "Europe/Brussels" })).json().error).toMatch(/^A schedule has five fields/);
    expect((await put({ cron: "*/5 * * * *", timeZone: "Europe/Brussels" })).json().error).toMatch(/^Runs must be at least 15 minutes apart/);
    expect((await put({ cron: "30 7 * * *", timeZone: "Europe/Nowhere" })).json().error).toMatch(/is not a time zone/);
    expect((await put({ cron: "30 7 * * *" })).statusCode).toBe(400);

    const unmeasurable = await pipelineOf("Nothing to measure");
    const res = await call("PUT", `/pipelines/${unmeasurable.id}/schedule`, admin, weekdays);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/^There is no database user for space S yet/);
  });

  it("are another account's business: 404", async () => {
    const pipeline = await pipelineOf("Privately scheduled", ["V_OUT"]);
    const url = `/pipelines/${pipeline.id}/schedule`;
    await call("PUT", url, admin, weekdays);
    expect((await call("GET", url, stranger)).statusCode).toBe(404);
    expect((await call("PUT", url, stranger, weekdays)).statusCode).toBe(404);
    expect((await call("DELETE", url, stranger)).statusCode).toBe(404);
    expect((await call("GET", url, admin)).json().schedule).toMatchObject({ cron: "30 7 * * 1-5" });
  });

  it("go with their pipeline", async () => {
    const pipeline = await pipelineOf("Deleted with its schedule", ["V_OUT"]);
    await call("PUT", `/pipelines/${pipeline.id}/schedule`, admin, weekdays);
    await deletePipeline(db, pipeline.id);
    expect(await getSchedule(db, pipeline.id)).toBeUndefined();
  });
});

describe("watching a pipeline", () => {
  it("is open to everyone in the account, and whoever saves a pipeline watches it", async () => {
    const tenantPipeline = await pipelineOf("Watched", ["V_OUT"]);
    const saved = await app.inject({
      method: "POST",
      url: `/api/tenants/${tenantPipeline.tenantId}/pipelines`,
      headers: { cookie: admin.cookie },
      payload: { name: "Saved and watched", output: "S.V_OUT" },
    });
    expect(saved.statusCode).toBe(201);
    const url = `/pipelines/${saved.json().id}/watch`;
    expect((await call("GET", url, admin)).json()).toEqual({ watching: true, watchers: 1 });

    expect((await call("GET", url, viewer)).json()).toEqual({ watching: false, watchers: 1 });
    expect((await call("PUT", url, viewer)).json()).toEqual({ watching: true, watchers: 2 });
    expect((await call("PUT", url, viewer)).json()).toEqual({ watching: true, watchers: 2 });
    expect((await call("DELETE", url, admin)).json()).toEqual({ watching: false, watchers: 1 });
    expect((await call("GET", url, coordinator)).json()).toEqual({ watching: false, watchers: 1 });
  });

  it("is another account's business: 404", async () => {
    const pipeline = await pipelineOf("Watched privately", ["V_OUT"]);
    for (const method of ["GET", "PUT", "DELETE"] as const) expect((await call(method, `/pipelines/${pipeline.id}/watch`, stranger)).statusCode).toBe(404);
  });

  it("alerts above the row drop the schedule sets, 20% unless it says otherwise", async () => {
    const pipeline = await pipelineOf("Alert threshold", ["V_OUT"]);
    const url = `/pipelines/${pipeline.id}/schedule`;
    expect((await call("PUT", url, admin, { cron: "0 6 * * *", timeZone: "UTC" })).json().schedule).toMatchObject({ rowDropPercent: 20 });
    expect((await call("PUT", url, admin, { cron: "0 6 * * *", timeZone: "UTC", rowDropPercent: 5 })).json().schedule).toMatchObject({ rowDropPercent: 5 });
    for (const rowDropPercent of [0, 101, 2.5]) expect((await call("PUT", url, admin, { cron: "0 6 * * *", timeZone: "UTC", rowDropPercent })).statusCode).toBe(400);
  });
});
