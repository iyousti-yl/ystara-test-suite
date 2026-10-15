import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObjectSource } from "@ystara/connector";
import { createScan, createTenant, loadGraph, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { runScan } from "./scan.js";

// A tiny synthetic space: DF_LOAD (write step "producer1") loads LT_DATA, V_OUT reads it.
const SPACE: Record<string, Record<string, unknown>> = {
  "local-tables": { LT_DATA: { definitions: { LT_DATA: { kind: "entity" } } } },
  "data-flows": {
    DF_LOAD: {
      dataflows: { DF_LOAD: { contents: { processes: { producer1: { component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: "LT_DATA" } } } } } } },
    },
  },
  views: { V_OUT: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "LT_DATA"' } } } },
};

const fakeTenant: ObjectSource = {
  async listObjects(_space, kind) {
    return Object.keys(SPACE[kind] ?? {}).map((technicalName) => ({ technicalName }));
  },
  async readObject(_space, kind, name) {
    return SPACE[kind][name];
  },
};

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("runScan", () => {
  it("reads the spaces and stores the lineage graph", async () => {
    const tenant = await createTenant(db, { name: "Fake", host: "https://fake.example.com" });
    const scan = await createScan(db, tenant.id, ["S"]);
    const done = await runScan(db, scan.id, () => fakeTenant);
    expect(done).toMatchObject({ status: "succeeded", objectCount: 3, edgeCount: 2, warnings: [] });
    const edges = (await loadGraph(db, scan.id)).edges.map((e) => `${e.from.technicalName} ${e.kind} ${e.to.technicalName}`);
    expect(edges.sort()).toEqual(["DF_LOAD writes_to LT_DATA", "LT_DATA reads_from V_OUT"]);
  });

  it("fails clearly when nothing can be read, e.g. an expired login", async () => {
    const tenant = await createTenant(db, { name: "Logged out", host: "https://fake.example.com" });
    const scan = await createScan(db, tenant.id, ["S"]);
    const loggedOut: ObjectSource = {
      async listObjects() {
        throw new Error("401 Unauthorized: run datasphere login");
      },
      async readObject() {
        throw new Error("unreachable");
      },
    };
    const done = await runScan(db, scan.id, () => loggedOut);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/Nothing could be read.*401 Unauthorized/);
    expect(done?.warnings.length).toBeGreaterThan(0);
  });

  it("fails with the reason when the tenant can't be reached at all", async () => {
    const tenant = await createTenant(db, { name: "Imported only", host: null });
    const scan = await createScan(db, tenant.id, ["S"]);
    const done = await runScan(db, scan.id, () => {
      throw new Error('Tenant "Imported only" has no Datasphere URL');
    });
    expect(done).toMatchObject({ status: "failed", error: 'Tenant "Imported only" has no Datasphere URL' });
  });
});
