import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import { createScan, getConnectionLogin, recordConnectionCheck, saveScanResult, setConnection, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { Pipeline } from "@ystara/shared";
import { testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { buildServer } from "../server.js";

// Synthetic space: two flows write LT_DATA (one from another process), V_OUT reads it.
const producer = (table: string) => ({ component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: table } } });
const RAW: RawObject[] = [
  { space: "S", kind: "local-tables", technicalName: "LT_DATA", definition: { definitions: { LT_DATA: { kind: "entity" } } } },
  { space: "S", kind: "local-tables", technicalName: "LT_OLD", definition: { definitions: { LT_OLD: { kind: "entity" } } } },
  { space: "S", kind: "data-flows", technicalName: "DF_LOAD", definition: { dataflows: { DF_LOAD: { contents: { processes: { producer1: producer("LT_DATA") } } } } } },
  {
    space: "S",
    kind: "data-flows",
    technicalName: "DF_OTHER_RELOAD",
    definition: {
      dataflows: {
        DF_OTHER_RELOAD: {
          contents: {
            processes: {
              consumer1: { component: "com.sap.database.table.consumer", metadata: { config: { dwcEntity: "LT_OLD" } } },
              producer1: producer("LT_DATA"),
            },
          },
        },
      },
    },
  },
  { space: "S", kind: "views", technicalName: "V_OUT", definition: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "LT_DATA"' } } } },
];

const tokenUrl = "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token";

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
const sent: { name: string; data: object }[] = [];

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async (name, data) => sent.push({ name, data }) }, secrets: testSecrets }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

// As the account's admin, unless another user is given.
const post = (url: string, payload: object, as = admin) => app.inject({ method: "POST", url: `/api${url}`, payload, headers: { cookie: as.cookie } });
const get = (url: string, as = admin) => app.inject({ method: "GET", url: `/api${url}`, headers: { cookie: as.cookie } });
const del = (url: string, as = admin) => app.inject({ method: "DELETE", url: `/api${url}`, headers: { cookie: as.cookie } });

async function tenantWithScan(name: string) {
  const tenant = (await post("/tenants", { name, host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
  const scan = await createScan(db, tenant.id, ["S"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
  return { tenant, scan };
}

describe("tenants", () => {
  it("are created and listed", async () => {
    const res = await post("/tenants", { name: "Partner", host: "https://synthetic.eu10.hcs.cloud.sap" });
    expect(res.statusCode).toBe(201);
    expect((await get("/tenants")).json().map((t: { name: string }) => t.name)).toContain("Partner");
    expect((await get(`/tenants/${res.json().id}`)).json()).toMatchObject({ name: "Partner", host: "https://synthetic.eu10.hcs.cloud.sap" });
  });

  it("need a Datasphere URL and a unique name", async () => {
    for (const host of ["http://synthetic.eu10.hcs.cloud.sap", "https://synthetic.example.com", "https://10.0.0.1", "https://synthetic.eu10.hcs.cloud.sap:8443"]) {
      const res = await post("/tenants", { name: "Bad", host });
      expect(res.statusCode, host).toBe(400);
      expect(res.json().issues[0].message, host).toMatch(/hcs\.cloud\.sap/);
    }
    expect((await post("/tenants", { name: "Partner", host: "https://synthetic.eu10.hcs.cloud.sap" })).statusCode).toBe(409);
  });
});

describe("scans", () => {
  it("are queued for the worker and never run by the API", async () => {
    const tenant = (await post("/tenants", { name: "To scan", host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
    const res = await post(`/tenants/${tenant.id}/scans`, { spaces: ["HR", "SHARED"] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "queued", spaces: ["HR", "SHARED"] });
    expect(sent.at(-1)).toEqual({ name: "discovery-scan", data: { scanId: res.json().id } });
    expect((await get(`/scans/${res.json().id}`)).json().status).toBe("queued");
    expect((await get(`/scans/${res.json().id}/graph`)).statusCode).toBe(409);
  });

  it("of a tenant with a technical client, read only the spaces its last check could read", async () => {
    const tenant = (await post("/tenants", { name: "Connected", host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
    await setConnection(db, { tenantId: tenant.id, clientId: "sb-synthetic", sealedSecret: "v1.sealed", tokenUrl, spaces: ["SALES", "HR"], updatedBy: null });
    const notYet = await post(`/tenants/${tenant.id}/scans`, { spaces: ["SALES"] });
    expect(notYet.statusCode).toBe(409);
    expect(notYet.json().error).toMatch(/can't read SALES/);

    const login = (await getConnectionLogin(db, tenant.id))!;
    await recordConnectionCheck(db, login, { spaces: [{ space: "SALES", readable: true, error: null }, { space: "HR", readable: false, error: "403" }] });
    expect((await post(`/tenants/${tenant.id}/scans`, { spaces: ["SALES"] })).statusCode).toBe(202);
    for (const spaces of [["HR"], ["SALES", "FINANCE"]]) {
      expect((await post(`/tenants/${tenant.id}/scans`, { spaces })).statusCode, spaces.join()).toBe(409);
    }
  });

  it("reject space names that aren't plain IDs", async () => {
    const tenant = (await post("/tenants", { name: "Strict", host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
    expect((await post(`/tenants/${tenant.id}/scans`, { spaces: ["HR; rm -rf"] })).statusCode).toBe(400);
    expect((await post(`/tenants/${tenant.id}/scans`, { spaces: [] })).statusCode).toBe(400);
  });

  it("answer 400 for a malformed id and 404 for an unknown one", async () => {
    expect((await get("/scans/not-a-uuid")).statusCode).toBe(400);
    expect((await get("/scans/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("serve the lineage graph without definitions", async () => {
    const { scan } = await tenantWithScan("Graph");
    const graph = (await get(`/scans/${scan.id}/graph`)).json();
    expect(graph.nodes).toHaveLength(5);
    expect(graph.nodes.every((n: object) => !("definition" in n))).toBe(true);
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "writes_to", from: expect.objectContaining({ technicalName: "DF_LOAD" }) }));
  });
});

describe("objects", () => {
  it("come with their definition and every edge that touches them", async () => {
    const { scan } = await tenantWithScan("Objects");
    const res = await get(`/scans/${scan.id}/objects/S/LT_DATA`);
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toMatchObject({ technicalName: "LT_DATA", type: "local_table", definition: RAW[0].definition });
    expect(res.json().edges).toHaveLength(3);
    expect((await get(`/scans/${scan.id}/objects/S/NOPE`)).statusCode).toBe(404);
    expect((await get(`/scans/${scan.id}/objects/S/..%2Fetc`)).statusCode).toBe(400);
  });
});

describe("pipelines", () => {
  it("can be tried on a scan, flagging a table with two writers", async () => {
    const { scan } = await tenantWithScan("Try");
    const res = await get(`/scans/${scan.id}/pipeline?output=V_OUT`);
    expect(res.statusCode).toBe(200);
    const p: Pipeline = res.json().pipeline;
    expect(p.ambiguousWriters.map((a) => a.writers.map((w) => w.technicalName))).toEqual([["DF_LOAD", "DF_OTHER_RELOAD"]]);
    expect(res.json().mermaid).toMatch(/^flowchart LR/);
    expect(res.json().graph.nodes.map((n: { technicalName: string }) => n.technicalName).sort()).toEqual(["DF_LOAD", "DF_OTHER_RELOAD", "LT_DATA", "LT_OLD", "V_OUT"]);
  });

  it("leave out excluded writers, given in the query", async () => {
    const { scan } = await tenantWithScan("Exclude");
    const p: Pipeline = (await get(`/scans/${scan.id}/pipeline?output=S.V_OUT&excludeWriter=DF_OTHER_*&excludeWriter=NONE`)).json().pipeline;
    expect(p.steps.map((s) => s.technicalName)).toEqual(["DF_LOAD", "LT_DATA", "V_OUT"]);
    expect(p.excludedWriters.map((x) => x.writer.technicalName)).toEqual(["DF_OTHER_RELOAD"]);
  });

  it("draw the excluded writer next to the table it writes, without its own inputs", async () => {
    const { scan } = await tenantWithScan("Drawn");
    const { graph } = (await get(`/scans/${scan.id}/pipeline?output=V_OUT&excludeWriter=DF_OTHER_RELOAD`)).json();
    expect(graph.nodes.map((n: { technicalName: string }) => n.technicalName).sort()).toEqual(["DF_LOAD", "DF_OTHER_RELOAD", "LT_DATA", "V_OUT"]);
    expect(graph.edges.map((e: { from: { technicalName: string }; to: { technicalName: string } }) => `${e.from.technicalName}>${e.to.technicalName}`).sort()).toEqual([
      "DF_LOAD>LT_DATA",
      "DF_OTHER_RELOAD>LT_DATA",
      "LT_DATA>V_OUT",
    ]);
  });

  it("are saved and computed on the tenant's latest successful scan", async () => {
    const { tenant, scan } = await tenantWithScan("Saved");
    const created = await post(`/tenants/${tenant.id}/pipelines`, { name: "Output", output: "S.V_OUT", excludeWriters: ["DF_OTHER_RELOAD"] });
    expect(created.statusCode).toBe(201);
    const res = (await get(`/pipelines/${created.json().id}`)).json();
    expect(res.scanId).toBe(scan.id);
    expect(res.pipeline.steps).toHaveLength(3);
    expect((await get(`/tenants/${tenant.id}/pipelines`)).json()).toHaveLength(1);
    expect((await del(`/pipelines/${created.json().id}`)).statusCode).toBe(204);
  });

  it("explain what is missing instead of failing", async () => {
    const { tenant, scan } = await tenantWithScan("Missing");
    expect((await get(`/scans/${scan.id}/pipeline?output=NOPE`)).statusCode).toBe(404);
    const created = (await post(`/tenants/${tenant.id}/pipelines`, { name: "Gone", output: "S.NOPE" })).json();
    const res = await get(`/pipelines/${created.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not in the latest scan/);

    const fresh = (await post("/tenants", { name: "Never scanned", host: "https://synthetic.eu10.hcs.cloud.sap" })).json();
    const p = (await post(`/tenants/${fresh.id}/pipelines`, { name: "Early", output: "S.V_OUT" })).json();
    expect((await get(`/pipelines/${p.id}`)).json().error).toMatch(/no successful scan/);
  });
});

describe("access", () => {
  it("needs a signed-in user", async () => {
    for (const url of ["/tenants", "/scans/00000000-0000-4000-8000-000000000000"]) {
      expect((await app.inject({ method: "GET", url: `/api${url}` })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/tenants", payload: { name: "Anon", host: "https://synthetic.eu10.hcs.cloud.sap" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/tenants", headers: { cookie: "ystara_session=made-up" } })).statusCode).toBe(401);
  });

  it("lets each role do what roles.ts allows", async () => {
    const { tenant, scan } = await tenantWithScan("Roles");
    const viewer = await testUser(db, { account: "Customer", email: "viewer@customer.example.com", role: "viewer" });
    const developer = await testUser(db, { account: "Customer", email: "dev@customer.example.com", role: "developer" });

    expect((await get(`/scans/${scan.id}/pipeline?output=V_OUT`, viewer)).statusCode).toBe(200);
    expect((await post("/tenants", { name: "By viewer", host: "https://synthetic.eu10.hcs.cloud.sap" }, viewer)).statusCode).toBe(403);
    expect((await post(`/tenants/${tenant.id}/scans`, { spaces: ["S"] }, viewer)).statusCode).toBe(403);
    expect((await post(`/tenants/${tenant.id}/pipelines`, { name: "By viewer", output: "S.V_OUT" }, viewer)).json().error).toBe("Your role (viewer) can't do this");

    expect((await post("/tenants", { name: "By developer", host: "https://synthetic.eu10.hcs.cloud.sap" }, developer)).statusCode).toBe(403);
    expect((await post(`/tenants/${tenant.id}/scans`, { spaces: ["S"] }, developer)).statusCode).toBe(202);
    const pipeline = await post(`/tenants/${tenant.id}/pipelines`, { name: "By developer", output: "S.V_OUT" }, developer);
    expect(pipeline.statusCode).toBe(201);
    expect((await del(`/pipelines/${pipeline.json().id}`, viewer)).statusCode).toBe(403);
    expect((await del(`/pipelines/${pipeline.json().id}`, developer)).statusCode).toBe(204);
  });

  it("shows each account only its own tenants, scans and pipelines", async () => {
    const { tenant, scan } = await tenantWithScan("Private");
    const pipeline = (await post(`/tenants/${tenant.id}/pipelines`, { name: "Private", output: "S.V_OUT" })).json();
    const outsider = await testUser(db, { account: "Other customer", email: "admin@other.example.com", role: "admin" });

    expect((await get("/tenants", outsider)).json()).toEqual([]);
    for (const url of [
      `/tenants/${tenant.id}`,
      `/tenants/${tenant.id}/scans`,
      `/tenants/${tenant.id}/pipelines`,
      `/scans/${scan.id}`,
      `/scans/${scan.id}/graph`,
      `/scans/${scan.id}/objects/S/V_OUT`,
      `/scans/${scan.id}/pipeline?output=V_OUT`,
      `/pipelines/${pipeline.id}`,
    ]) {
      expect((await get(url, outsider)).statusCode, url).toBe(404);
    }
    expect((await post(`/tenants/${tenant.id}/scans`, { spaces: ["S"] }, outsider)).statusCode).toBe(404);
    expect((await post(`/tenants/${tenant.id}/pipelines`, { name: "Theirs", output: "S.V_OUT" }, outsider)).statusCode).toBe(404);
    expect((await del(`/pipelines/${pipeline.id}`, outsider)).statusCode).toBe(404);
    expect((await get(`/pipelines/${pipeline.id}`)).statusCode).toBe(200);

    // The same tenant name is fine in another account.
    expect((await post("/tenants", { name: "Private", host: "https://synthetic.eu10.hcs.cloud.sap" }, outsider)).statusCode).toBe(201);
  });
});
