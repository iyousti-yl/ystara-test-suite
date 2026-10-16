import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObjectSource } from "@ystara/connector";
import { createAccount, createScan, createTenant, loadGraph, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { runScan, type TenantAccess } from "./scan.js";

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

const access = (source: ObjectSource, more: Partial<TenantAccess> = {}) => async (): Promise<TenantAccess> => ({ source, login: "client", ...more });
const client = { clientId: "sb-synthetic", clientSecret: "synthetic-secret" };

const fakeTenant: ObjectSource = {
  async listObjects(_space, kind) {
    return Object.keys(SPACE[kind] ?? {}).map((technicalName) => ({ technicalName }));
  },
  async readObject(_space, kind, name) {
    return SPACE[kind][name];
  },
};

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterAll(async () => {
  await db.close();
});

describe("runScan", () => {
  it("reads the spaces and stores the lineage graph", async () => {
    const tenant = await createTenant(db, { accountId, name: "Fake", host: "https://synthetic.eu10.hcs.cloud.sap" });
    const scan = await createScan(db, tenant.id, ["S"]);
    let closed = false;
    const done = await runScan(db, scan.id, access(fakeTenant, { close: async () => void (closed = true) }));
    expect(done).toMatchObject({ status: "succeeded", objectCount: 3, edgeCount: 2, warnings: [] });
    expect(closed).toBe(true); // the client's folder, with its token, is gone
    const edges = (await loadGraph(db, scan.id)).edges.map((e) => `${e.from.technicalName} ${e.kind} ${e.to.technicalName}`);
    expect(edges.sort()).toEqual(["DF_LOAD writes_to LT_DATA", "LT_DATA reads_from V_OUT"]);
  });

  it("fails clearly when nothing can be read, says what to check for that login, and hides the secret", async () => {
    const loggedOut: ObjectSource = {
      async listObjects() {
        throw new Error("401 Unauthorized for client secret synthetic-secret");
      },
      async readObject() {
        throw new Error("unreachable");
      },
    };
    const tenant = await createTenant(db, { accountId, name: "Logged out", host: "https://synthetic.eu10.hcs.cloud.sap" });

    const withClient = await runScan(db, (await createScan(db, tenant.id, ["S"])).id, access(loggedOut, { client }));
    expect(withClient?.status).toBe("failed");
    expect(withClient?.error).toMatch(/Nothing could be read.*technical client.*401 Unauthorized/);
    expect(JSON.stringify(withClient)).not.toContain("synthetic-secret");
    expect(withClient?.warnings.length).toBeGreaterThan(0);

    const onMachine = await runScan(db, (await createScan(db, tenant.id, ["S"])).id, access(loggedOut, { login: "machine" }));
    expect(onMachine?.error).toMatch(/Nothing could be read.*CLI logged in on the machine/);
  });

  it("hides the secret and tokens in the warnings of a scan that succeeds", async () => {
    const leaky: ObjectSource = {
      ...fakeTenant,
      async readObject(space, kind, name) {
        if (name === "V_OUT") throw new Error("403 for Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl, secret synthetic-secret");
        return fakeTenant.readObject(space, kind, name);
      },
    };
    const tenant = await createTenant(db, { accountId, name: "Partly readable", host: "https://synthetic.eu10.hcs.cloud.sap" });
    const done = await runScan(db, (await createScan(db, tenant.id, ["S"])).id, access(leaky, { client }));
    expect(done).toMatchObject({ status: "succeeded", objectCount: 2 });
    expect(done?.warnings).toEqual(["S.V_OUT (views): could not read: 403 for Bearer <secret>, secret <secret>"]);
  });

  it("fails with the reason when the tenant can't be reached at all", async () => {
    const tenant = await createTenant(db, { accountId, name: "Imported only", host: null });
    const scan = await createScan(db, tenant.id, ["S"]);
    const done = await runScan(db, scan.id, async () => {
      throw new Error('Tenant "Imported only" has no Datasphere URL');
    });
    expect(done).toMatchObject({ status: "failed", error: 'Tenant "Imported only" has no Datasphere URL' });
  });
});
