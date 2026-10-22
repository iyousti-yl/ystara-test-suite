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
  saveScanResult,
  setDatabaseUser,
  watchPipeline,
  watcherEmails,
  watchState,
  type Db,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { ScenarioSpec, type PipelineDefinition, type Tenant } from "@ystara/shared";
import { testSecrets, testUser, type TestUser } from "./auth/testing.js";
import { buildServer } from "./server.js";

// Two synthetic spaces: STOCK's V_ITEMS reads its own LT_ITEMS and SALES's V_ORDERS.
const elements = { ID: { type: "cds.String", length: 10 } };
const table = (space: string, name: string): RawObject => ({ space, kind: "local-tables", technicalName: name, definition: { definitions: { [name]: { kind: "entity", elements } } } });
const view = (space: string, name: string, query: string): RawObject => ({
  space,
  kind: "views",
  technicalName: name,
  definition: { definitions: { [name]: { kind: "entity", "@DataWarehouse.sqlEditor.query": query, elements } } },
});
const RAW: RawObject[] = [
  table("SALES", "LT_ORDERS"),
  view("SALES", "V_ORDERS", 'SELECT "ID" FROM "LT_ORDERS"'),
  table("STOCK", "LT_ITEMS"),
  view("STOCK", "V_ITEMS", 'SELECT * FROM "LT_ITEMS" JOIN "SALES.V_ORDERS" ON 1 = 1'),
];
const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
/** A developer who sees SALES only. */
let sales: TestUser;
/** A test coordinator who sees STOCK only. */
let stock: TestUser;
/** A developer who sees every space. */
let everyone: TestUser;
let tenant: Tenant;
let scanId: string;
let salesPipeline: PipelineDefinition;
let stockPipeline: PipelineDefinition;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async () => {} }, secrets: testSecrets }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
  sales = await testUser(db, { account: "Customer", email: "sales@customer.example.com", role: "developer", spaces: ["SALES"] });
  stock = await testUser(db, { account: "Customer", email: "stock@customer.example.com", role: "test_coordinator", spaces: ["STOCK"] });
  everyone = await testUser(db, { account: "Customer", email: "everyone@customer.example.com", role: "developer" });
  tenant = await createTenant(db, { accountId: admin.accountId, name: "Spaces", host: "https://synthetic.eu10.hcs.cloud.sap" });
  const scan = await createScan(db, tenant.id, ["SALES", "STOCK"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["SALES", "STOCK"]));
  scanId = scan.id;
  salesPipeline = await createPipeline(db, { tenantId: tenant.id, name: "Orders", output: { space: "SALES", technicalName: "V_ORDERS" }, excludeWriters: [] });
  stockPipeline = await createPipeline(db, { tenantId: tenant.id, name: "Items", output: { space: "STOCK", technicalName: "V_ITEMS" }, excludeWriters: [] });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, as: TestUser, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: { cookie: as.cookie }, payload });
const names = (list: { technicalName: string }[]) => list.map((n) => n.technicalName).sort();
const links = (edges: { from: { technicalName: string }; to: { technicalName: string } }[]) => edges.map((e) => `${e.from.technicalName}>${e.to.technicalName}`).sort();

describe("a member limited to some spaces", () => {
  it("is told so when signed in, and an admin never is", async () => {
    expect((await call("GET", "/auth/me", sales)).json().spaces).toEqual(["SALES"]);
    expect((await call("GET", "/auth/me", everyone)).json().spaces).toBeNull();
    expect((await call("GET", "/auth/me", admin)).json().spaces).toBeNull();
  });

  it("sees only the pipelines whose output is in one of their spaces", async () => {
    const list = async (as: TestUser) => ((await call("GET", `/tenants/${tenant.id}/pipelines`, as)).json() as PipelineDefinition[]).map((p) => p.name);
    expect(await list(sales)).toEqual(["Orders"]);
    expect(await list(stock)).toEqual(["Items"]);
    expect((await list(everyone)).sort()).toEqual(["Items", "Orders"]);
  });

  it("gets 404 for another space's pipeline and for everything on it, as if it didn't exist", async () => {
    const spec = ScenarioSpec.parse({
      name: "Items",
      kind: "golden",
      pipeline: "STOCK.V_ITEMS",
      fixtures: [{ table: "STOCK.LT_ITEMS", rows: [{ ID: "1" }] }],
      expect: [{ checkpoint: "STOCK.V_ITEMS", assertions: [{ type: "row_count", equals: 1 }] }],
    });
    const scenario = await createScenario(db, { tenantId: tenant.id, pipelineId: stockPipeline.id, spec, createdBy: null });
    const run = await createScenarioRun(db, scenario, null);
    const suite = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: stockPipeline.id, cause: "manual", requestedBy: null });
    const snapshot = await createSnapshot(db, { tenantId: tenant.id, pipelineId: stockPipeline.id, requestedBy: null });
    const p = `/pipelines/${stockPipeline.id}`;
    const reads = [
      p,
      `${p}/scenario-inputs`,
      `${p}/scenarios`,
      `${p}/scenario-suites`,
      `${p}/snapshots`,
      `${p}/schedule`,
      `${p}/compare`,
      `${p}/signoffs`,
      `${p}/history`,
      `${p}/history.csv`,
      `${p}/report`,
      `/scenarios/${scenario.id}`,
      `/scenarios/${scenario.id}/runs`,
      `/scenario-runs/${run.id}`,
      `/scenario-suites/${suite.id}`,
      `/snapshots/${snapshot.id}`,
    ];
    for (const url of reads) {
      expect([url, (await call("GET", url, sales)).statusCode]).toEqual([url, 404]);
      expect([url, (await call("GET", url, stock)).statusCode]).not.toEqual([url, 404]);
    }
    const writes: ["POST" | "PUT" | "DELETE", string, object?][] = [
      ["POST", `${p}/snapshots`],
      ["POST", `${p}/scenario-suites`],
      ["POST", `${p}/scenarios`, spec],
      ["PUT", `/scenarios/${scenario.id}`, spec],
      ["POST", `/scenarios/${scenario.id}/runs`],
      ["DELETE", `/scenarios/${scenario.id}`],
      ["PUT", `${p}/watch`],
      ["DELETE", p],
    ];
    for (const [method, url, body] of writes) expect([method, url, (await call(method, url, sales, body)).statusCode]).toEqual([method, url, 404]);
    expect((await call("GET", p, stock)).statusCode).toBe(200);
    expect((await call("GET", `/pipelines/${salesPipeline.id}`, stock)).statusCode).toBe(404);
  });

  it("sees only their spaces in a scan, and every step of a pipeline they see", async () => {
    const graph = async (as: TestUser) => (await call("GET", `/scans/${scanId}/graph`, as)).json();
    expect(names((await graph(sales)).nodes)).toEqual(["LT_ORDERS", "V_ORDERS"]);
    expect(links((await graph(sales)).edges)).toEqual(["LT_ORDERS>V_ORDERS"]);
    expect(names((await graph(stock)).nodes)).toEqual(["LT_ITEMS", "V_ITEMS"]);
    expect(links((await graph(stock)).edges)).toEqual(["LT_ITEMS>V_ITEMS"]);
    expect(names((await graph(everyone)).nodes)).toEqual(["LT_ITEMS", "LT_ORDERS", "V_ITEMS", "V_ORDERS"]);

    // The STOCK pipeline reads SALES's V_ORDERS: its coordinator sees that step, from the pipeline only.
    const steps = (await call("GET", `/pipelines/${stockPipeline.id}`, stock)).json().pipeline.steps;
    expect(names(steps)).toEqual(["LT_ITEMS", "LT_ORDERS", "V_ITEMS", "V_ORDERS"]);
    const object = (as: TestUser, query = "") => call("GET", `/scans/${scanId}/objects/SALES/V_ORDERS${query}`, as);
    expect((await object(stock)).statusCode).toBe(404);
    expect((await object(stock, "?within=SALES.V_ORDERS")).statusCode).toBe(404);
    const within = await object(stock, "?within=STOCK.V_ITEMS");
    expect(within.statusCode).toBe(200);
    expect(links(within.json().edges)).toEqual(["LT_ORDERS>V_ORDERS", "V_ORDERS>V_ITEMS"]);
    // SALES's developer sees V_ORDERS, but not that STOCK reads it.
    expect(links((await object(sales)).json().edges)).toEqual(["LT_ORDERS>V_ORDERS"]);
    expect((await call("GET", `/scans/${scanId}/objects/STOCK/V_ITEMS?within=STOCK.V_ITEMS`, sales)).statusCode).toBe(404);
    expect((await call("GET", `/scans/${scanId}/pipeline?output=STOCK.V_ITEMS`, sales)).statusCode).toBe(404);
    expect((await call("GET", `/scans/${scanId}/pipeline?output=SALES.V_ORDERS`, sales)).statusCode).toBe(200);
  });

  it("can't scan, or save a pipeline in, another space, nor change the tenant's scan schedule", async () => {
    expect((await call("POST", `/tenants/${tenant.id}/scans`, sales, { spaces: ["SALES", "STOCK"] })).json().error).toMatch(/can't scan STOCK/);
    expect((await call("POST", `/tenants/${tenant.id}/scans`, sales, { spaces: ["SALES"] })).statusCode).toBe(202);
    const save = (output: string) => call("POST", `/tenants/${tenant.id}/pipelines`, sales, { name: `Mine ${output}`, output, excludeWriters: [] });
    expect((await save("STOCK.V_ITEMS")).statusCode).toBe(403);
    expect((await save("SALES.LT_ORDERS")).statusCode).toBe(201);
    const schedule = { cron: "0 2 * * *", timeZone: "Europe/Brussels" };
    expect((await call("PUT", `/tenants/${tenant.id}/scan-schedule`, sales, schedule)).statusCode).toBe(403);
    expect((await call("DELETE", `/tenants/${tenant.id}/scan-schedule`, sales)).statusCode).toBe(403);
    // Someone who sees every space gets past the check (and to the missing technical client).
    expect((await call("PUT", `/tenants/${tenant.id}/scan-schedule`, everyone, schedule)).statusCode).toBe(409);
  });

  it("sees and checks only their spaces' database users", async () => {
    for (const space of ["SALES", "STOCK"]) {
      await setDatabaseUser(db, { tenantId: tenant.id, space, host, user: `${space}#SYNTH`, sealedPassword: "v1.sealed", updatedBy: null });
    }
    const spaces = async (as: TestUser) => ((await call("GET", `/tenants/${tenant.id}/database-users`, as)).json() as { space: string }[]).map((u) => u.space);
    expect(await spaces(sales)).toEqual(["SALES"]);
    expect(await spaces(admin)).toEqual(["SALES", "STOCK"]);
    expect((await call("POST", `/tenants/${tenant.id}/database-users/STOCK/check`, sales)).statusCode).toBe(404);
    expect((await call("POST", `/tenants/${tenant.id}/database-users/SALES/check`, sales)).statusCode).toBe(202);
  });

  it("gets no alerts of a pipeline once it is in a space they don't see", async () => {
    for (const user of [admin, sales, stock, everyone]) await watchPipeline(db, stockPipeline.id, user.userId);
    expect(await watcherEmails(db, stockPipeline.id)).toEqual([admin.email, everyone.email, stock.email]);
    expect(await watchState(db, stockPipeline.id, stock.userId, stock.accountId)).toEqual({ watching: true, watchers: 3 });
  });
});

describe("an admin", () => {
  it("limits a member to some spaces, from those the scans covered or any other", async () => {
    expect((await call("GET", "/team/spaces", admin)).json()).toEqual(["SALES", "STOCK"]);
    expect((await call("GET", "/team/spaces", sales)).statusCode).toBe(403);

    const invited = await call("POST", "/team/invitations", admin, { email: "new@customer.example.com", role: "viewer", spaces: ["STOCK", "STOCK", "LATER"] });
    expect(invited.statusCode).toBe(201);
    expect(invited.json().invitation.spaces).toEqual(["LATER", "STOCK"]);
    expect((await call("POST", "/team/invitations", admin, { email: "none@customer.example.com", role: "viewer", spaces: [] })).statusCode).toBe(400);

    const member = await testUser(db, { account: "Customer", email: "moved@customer.example.com", role: "viewer" });
    const spacesOf = async () => ((await call("GET", "/team", admin)).json().members as { email: string; spaces: string[] | null }[]).find((m) => m.email === member.email)!.spaces;
    expect((await call("PATCH", `/team/members/${member.userId}`, admin, { role: "viewer", spaces: ["SALES"] })).statusCode).toBe(204);
    expect(await spacesOf()).toEqual(["SALES"]);
    expect((await call("GET", "/auth/me", member)).json().spaces).toEqual(["SALES"]);
    // A new role alone keeps the spaces; an admin sees every space.
    await call("PATCH", `/team/members/${member.userId}`, admin, { role: "developer" });
    expect(await spacesOf()).toEqual(["SALES"]);
    await call("PATCH", `/team/members/${member.userId}`, admin, { role: "admin", spaces: ["SALES"] });
    expect(await spacesOf()).toBeNull();
  });
});
