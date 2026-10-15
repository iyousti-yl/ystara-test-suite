import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import { createScan, saveScanResult, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { Pipeline } from "@ystara/shared";
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

let db: Db;
let app: FastifyInstance;
const sent: { name: string; data: object }[] = [];

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async (name, data) => sent.push({ name, data }) } }, { logger: false });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api${url}`, payload });
const get = (url: string) => app.inject({ method: "GET", url: `/api${url}` });

async function tenantWithScan(name: string) {
  const tenant = (await post("/tenants", { name, host: "https://synthetic.example.com" })).json();
  const scan = await createScan(db, tenant.id, ["S"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
  return { tenant, scan };
}

describe("tenants", () => {
  it("are created and listed", async () => {
    const res = await post("/tenants", { name: "Partner", host: "https://partner.example.com" });
    expect(res.statusCode).toBe(201);
    expect((await get("/tenants")).json().map((t: { name: string }) => t.name)).toContain("Partner");
    expect((await get(`/tenants/${res.json().id}`)).json()).toMatchObject({ name: "Partner", host: "https://partner.example.com" });
  });

  it("need an https URL and a unique name", async () => {
    expect((await post("/tenants", { name: "Bad", host: "http://plain.example.com" })).statusCode).toBe(400);
    expect((await post("/tenants", { name: "Partner", host: "https://other.example.com" })).statusCode).toBe(409);
  });
});

describe("scans", () => {
  it("are queued for the worker and never run by the API", async () => {
    const tenant = (await post("/tenants", { name: "To scan", host: "https://scan.example.com" })).json();
    const res = await post(`/tenants/${tenant.id}/scans`, { spaces: ["HR", "SHARED"] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "queued", spaces: ["HR", "SHARED"] });
    expect(sent.at(-1)).toEqual({ name: "discovery-scan", data: { scanId: res.json().id } });
    expect((await get(`/scans/${res.json().id}`)).json().status).toBe("queued");
    expect((await get(`/scans/${res.json().id}/graph`)).statusCode).toBe(409);
  });

  it("reject space names that aren't plain IDs", async () => {
    const tenant = (await post("/tenants", { name: "Strict", host: "https://strict.example.com" })).json();
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
    expect((await app.inject({ method: "DELETE", url: `/api/pipelines/${created.json().id}` })).statusCode).toBe(204);
  });

  it("explain what is missing instead of failing", async () => {
    const { tenant, scan } = await tenantWithScan("Missing");
    expect((await get(`/scans/${scan.id}/pipeline?output=NOPE`)).statusCode).toBe(404);
    const created = (await post(`/tenants/${tenant.id}/pipelines`, { name: "Gone", output: "S.NOPE" })).json();
    const res = await get(`/pipelines/${created.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not in the latest scan/);

    const fresh = (await post("/tenants", { name: "Never scanned", host: "https://new.example.com" })).json();
    const p = (await post(`/tenants/${fresh.id}/pipelines`, { name: "Early", output: "S.V_OUT" })).json();
    expect((await get(`/pipelines/${p.id}`)).json().error).toMatch(/no successful scan/);
  });
});
