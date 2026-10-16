import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LineageGraph } from "@ystara/shared";
import { connect, type Db } from "./db.js";
import { assertYstaraDatabase, migrate } from "./migrate.js";
import { createPipeline, deletePipeline, getPipeline, listPipelines } from "./pipelines.js";
import {
  createScan,
  getScan,
  latestSucceededScan,
  listScans,
  loadGraph,
  loadObject,
  loadRaw,
  markScanFailed,
  markScanRunning,
  saveScanResult,
  type StoredObject,
} from "./scans.js";
import { createTenant, findTenantByName, getTenant, listTenants } from "./tenants.js";
import { createTestDb } from "./testing.js";

// A tiny synthetic space: DF_LOAD writes LT_DATA, V_OUT reads LT_DATA.
const raw: StoredObject[] = [
  { space: "S", kind: "data-flows", technicalName: "DF_LOAD", definition: { dataflows: { DF_LOAD: { contents: {} } } } },
  { space: "S", kind: "local-tables", technicalName: "LT_DATA", businessName: "Data", definition: { definitions: { LT_DATA: { kind: "entity" } } } },
  { space: "S", kind: "views", technicalName: "V_OUT", definition: { definitions: { V_OUT: { kind: "entity" } } } },
];
const graph = (hashes: Record<string, string>): LineageGraph => ({
  scannedAt: "2026-01-01T00:00:00.000Z",
  spaces: ["S"],
  nodes: [
    { space: "S", technicalName: "DF_LOAD", type: "data_flow", definition: raw[0].definition, definitionHash: hashes.DF_LOAD ?? "h-df" },
    { space: "S", technicalName: "LT_DATA", type: "local_table", businessName: "Data", definition: raw[1].definition, definitionHash: hashes.LT_DATA ?? "h-lt" },
    { space: "S", technicalName: "V_OUT", type: "sql_view", definition: raw[2].definition, definitionHash: hashes.V_OUT ?? "h-v" },
  ],
  edges: [
    { from: { space: "S", technicalName: "DF_LOAD", type: "data_flow" }, to: { space: "S", technicalName: "LT_DATA", type: "local_table" }, kind: "writes_to" },
    { from: { space: "S", technicalName: "LT_DATA", type: "local_table" }, to: { space: "S", technicalName: "V_OUT", type: "sql_view" }, kind: "reads_from" },
  ],
  warnings: ["S.V_OTHER (views): could not read: 403"],
});

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("migrations", () => {
  it("apply once: a second run has nothing left to do", async () => {
    expect(await migrate(db)).toEqual([]);
  });
});

describe("tenants", () => {
  it("are created, listed and found by id and name", async () => {
    const t = await createTenant(db, { name: "Partner", host: "https://partner.example.com" });
    expect((await listTenants(db)).map((x) => x.name)).toContain("Partner");
    expect((await getTenant(db, t.id))?.host).toBe("https://partner.example.com");
    expect((await findTenantByName(db, "Partner"))?.id).toBe(t.id);
  });

  it("have unique names", async () => {
    await expect(createTenant(db, { name: "Partner", host: null })).rejects.toThrow();
  });
});

describe("scans", () => {
  it("go from queued to running to succeeded and keep their graph", async () => {
    const tenant = await createTenant(db, { name: "Scanned", host: null });
    const queued = await createScan(db, tenant.id, ["S"]);
    expect(queued).toMatchObject({ status: "queued", spaces: ["S"], source: "tenant", objectCount: null });

    await markScanRunning(db, queued.id);
    expect((await getScan(db, queued.id))?.status).toBe("running");

    const done = await saveScanResult(db, queued.id, raw, graph({}));
    expect(done).toMatchObject({ status: "succeeded", objectCount: 3, edgeCount: 2, warnings: ["S.V_OTHER (views): could not read: 403"] });
    expect(done.finishedAt).toBeInstanceOf(Date);

    const g = await loadGraph(db, queued.id);
    expect(g.nodes.map((n) => [n.technicalName, n.type, n.definition])).toEqual([
      ["DF_LOAD", "data_flow", undefined],
      ["LT_DATA", "local_table", undefined],
      ["V_OUT", "sql_view", undefined],
    ]);
    expect(g.nodes[1].businessName).toBe("Data");
    expect(g.edges).toEqual(graph({}).edges.sort((a, b) => (a.from.technicalName < b.from.technicalName ? -1 : 1)));
    expect((await loadGraph(db, queued.id, { definitions: true })).nodes[2].definition).toEqual(raw[2].definition);
    expect(await loadRaw(db, queued.id)).toEqual(raw);

    const lt = await loadObject(db, queued.id, "S", "LT_DATA");
    expect(lt?.object).toMatchObject({ technicalName: "LT_DATA", type: "local_table", businessName: "Data", definition: raw[1].definition, definitionHash: "h-lt" });
    expect(lt?.edges.map((e) => `${e.from.technicalName} ${e.kind} ${e.to.technicalName} (${e.to.type})`)).toEqual([
      "LT_DATA reads_from V_OUT (sql_view)",
      "DF_LOAD writes_to LT_DATA (local_table)",
    ]);
    expect(await loadObject(db, queued.id, "S", "NOPE")).toBeUndefined();
  });

  it("store each definition once per tenant, however often it is scanned", async () => {
    const tenant = await createTenant(db, { name: "Rescanned", host: null });
    for (const v of ["h-v1", "h-v1", "h-v2"]) {
      const scan = await createScan(db, tenant.id, ["S"]);
      await saveScanResult(db, scan.id, raw, graph({ V_OUT: v }));
    }
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from object_definitions where tenant_id = $1", [tenant.id]);
    expect(rows[0].n).toBe(4); // DF_LOAD, LT_DATA and two versions of V_OUT
  });

  it("can be saved again without duplicating rows", async () => {
    const tenant = await createTenant(db, { name: "Retried", host: null });
    const scan = await createScan(db, tenant.id, ["S"]);
    await saveScanResult(db, scan.id, raw, graph({}));
    await saveScanResult(db, scan.id, raw, graph({}));
    expect((await loadGraph(db, scan.id)).nodes).toHaveLength(3);
  });

  it("keep the task chain edges that run a step and that clear a table", async () => {
    const tenant = await createTenant(db, { name: "Chained", host: null });
    const scan = await createScan(db, tenant.id, ["S"], "import");
    const tc = { space: "S", technicalName: "TC_DAILY", type: "task_chain" as const };
    const g = graph({});
    g.nodes.push({ ...tc, definition: {}, definitionHash: "h-tc" });
    g.edges.push({ from: tc, to: g.edges[0].from, kind: "triggers" }, { from: tc, to: g.edges[0].to, kind: "clears" });
    await saveScanResult(db, scan.id, [...raw, { space: "S", kind: "task-chains", technicalName: "TC_DAILY", definition: {} }], g);
    const kinds = (await loadGraph(db, scan.id)).edges.filter((e) => e.from.technicalName === "TC_DAILY").map((e) => `${e.kind} ${e.to.technicalName}`);
    expect(kinds).toEqual(["triggers DF_LOAD", "clears LT_DATA"]);
  });

  it("record why they failed, and only succeeded scans count as latest", async () => {
    const tenant = await createTenant(db, { name: "Failing", host: null });
    const ok = await createScan(db, tenant.id, ["S"]);
    await saveScanResult(db, ok.id, raw, graph({}));
    const bad = await createScan(db, tenant.id, ["S"]);
    await markScanFailed(db, bad.id, "Not logged in", ["S: could not list views: 401"]);

    expect(await getScan(db, bad.id)).toMatchObject({ status: "failed", error: "Not logged in", warnings: ["S: could not list views: 401"] });
    expect((await listScans(db, tenant.id)).map((s) => s.id)).toEqual([bad.id, ok.id]);
    expect((await latestSucceededScan(db, tenant.id))?.id).toBe(ok.id);
  });
});

describe("pipelines", () => {
  it("are created, listed, read and deleted", async () => {
    const tenant = await createTenant(db, { name: "With pipelines", host: null });
    const p = await createPipeline(db, { tenantId: tenant.id, name: "Headcount", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: ["DF_OTHER_*"] });
    expect(await getPipeline(db, p.id)).toMatchObject({ name: "Headcount", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: ["DF_OTHER_*"] });
    expect((await listPipelines(db, tenant.id)).map((x) => x.id)).toEqual([p.id]);
    expect(await deletePipeline(db, p.id)).toBe(true);
    expect(await getPipeline(db, p.id)).toBeUndefined();
    expect(await deletePipeline(db, p.id)).toBe(false);
  });
});

describe("the wrong database", () => {
  it("is refused by migrate when it already holds someone else's tables", async () => {
    const other = await createTestDb({ migrated: false });
    await other.exec("create table invoices (id int)");
    await expect(migrate(other)).rejects.toThrow(/in-memory test database is not Ystara's: it has 1 tables but no schema_migrations/);
    await other.close();
  });

  it("stops the API, worker and tools before they touch it", async () => {
    const empty = await createTestDb({ migrated: false });
    await expect(assertYstaraDatabase(empty)).rejects.toThrow(/not a Ystara database.*db:migrate/);
    await migrate(empty);
    await expect(assertYstaraDatabase(empty)).resolves.toBeUndefined();
    await empty.query("delete from schema_migrations");
    await expect(assertYstaraDatabase(empty)).rejects.toThrow(/needs migrations 001_discovery\.sql/);
    await empty.close();
  });

  it("is named in errors without its password", () => {
    expect(connect("postgres://ystara:hunter2@db.example.com:55432/ystara").where).toBe("db.example.com:55432/ystara");
  });
});
