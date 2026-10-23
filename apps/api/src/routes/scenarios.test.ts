import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { graphFromRaw, type RawObject } from "@ystara/connector";
import { createPipeline, createScan, createTenant, finishScenarioRun, getDatabaseUserLogin, recordDatabaseCheck, saveScanResult, setDatabaseUser, startScenarioRun, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { JOBS } from "@ystara/shared";
import { testUser, testSecrets, type TestUser } from "../auth/testing.js";
import type { DraftBrief, ScenarioDrafter } from "../drafting.js";
import { DraftFailed } from "../drafting.js";
import { buildServer } from "../server.js";

// Synthetic space: V_OUT keeps the open rows of LT_DATA.
const elements = { ID: { type: "cds.String", length: 10 }, STATUS: { type: "cds.String", length: 10 }, AMOUNT: { type: "cds.Decimal", precision: 15, scale: 2 } };
const RAW: RawObject[] = [
  { space: "S", kind: "local-tables", technicalName: "LT_DATA", definition: { definitions: { LT_DATA: { kind: "entity", elements } } } },
  {
    space: "S",
    kind: "views",
    technicalName: "V_OUT",
    definition: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": `SELECT "ID", "AMOUNT" FROM "LT_DATA" WHERE "STATUS" = 'OPEN'`, elements } } },
  },
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

/** A scanned tenant with a saved pipeline for V_OUT; with `databaseUser`, a connected database user of S. */
async function pipelineOf(name: string, databaseUser = false) {
  const tenant = await createTenant(db, { accountId: admin.accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const scan = await createScan(db, tenant.id, ["S"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
  if (databaseUser) {
    await setDatabaseUser(db, { tenantId: tenant.id, space: "S", host, user: "S#SYNTH", sealedPassword: "v1.sealed", updatedBy: null });
    await recordDatabaseCheck(db, (await getDatabaseUserLogin(db, tenant.id, "S"))!, { visible: [{ name: "V_OUT", type: "VIEW" }] });
  }
  return createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
}

const draft = (name: string, extra: object = {}) => ({
  name,
  kind: "golden" as const,
  fixtures: [{ table: "S.LT_DATA", rows: [{ ID: "1", STATUS: "OPEN", AMOUNT: 10.5 }, { ID: "2", STATUS: "CLOSED", AMOUNT: 3 }] }],
  expect: [{ checkpoint: "S.V_OUT", assertions: [{ type: "row_count" as const, equals: 1 }] }],
  ...extra,
});

describe("building a scenario", () => {
  it("offers the tables that take rows, with their columns, and the steps a check can be on", async () => {
    const pipeline = await pipelineOf("Inputs");
    const res = await call("GET", `/pipelines/${pipeline.id}/scenario-inputs`, viewer);
    expect(res.statusCode).toBe(200);
    const inputs = res.json();
    expect(inputs.tables).toEqual([
      {
        space: "S",
        technicalName: "LT_DATA",
        type: "local_table",
        why: "nothing in the pipeline loads it",
        columns: [
          { name: "ID", type: "NVARCHAR(10)" },
          // V_OUT keeps the rows whose STATUS is OPEN.
          { name: "STATUS", type: "NVARCHAR(10)", used: true, keeps: "OPEN" },
          { name: "AMOUNT", type: "DECIMAL(15, 2)" },
        ],
      },
    ]);
    // This server has no Anthropic API key, so the builder doesn't offer drafting.
    expect(inputs.drafting).toBe(false);
    expect(inputs.checkpoints.map((c: { technicalName: string }) => c.technicalName)).toEqual(["LT_DATA", "V_OUT"]);
    expect((await call("GET", `/pipelines/${pipeline.id}/scenario-inputs`, stranger)).statusCode).toBe(404);
  });

  it("compiles a draft as it is, without saving it, and says what is wrong with it", async () => {
    const pipeline = await pipelineOf("Check");
    const ok = await call("POST", `/pipelines/${pipeline.id}/scenario-check`, viewer, draft("Open rows"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ problems: [], checks: [{ checkpoint: "S.V_OUT", label: "row_count = 1", problem: null }] });

    const misplaced = await call("POST", `/pipelines/${pipeline.id}/scenario-check`, viewer, {
      ...draft("Misplaced"),
      fixtures: [{ table: "S.V_OUT", rows: [] }],
      expect: [{ checkpoint: "S.V_NOPE", assertions: [{ type: "row_count", equals: 0 }] }],
    });
    expect(misplaced.json()).toMatchObject({
      problems: ["S.V_OUT is a sql view: test rows stand in for tables, so give rows to the tables it reads."],
      checks: [{ problem: "S.V_NOPE isn't a step of the pipeline." }],
    });

    const invalid = await call("POST", `/pipelines/${pipeline.id}/scenario-check`, viewer, { ...draft("Invalid"), expect: [], run: [] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues.map((i: { message: string }) => i.message)).toEqual(["expect: Array must contain at least 1 element(s)", "the file: Unrecognized key(s) in object: 'run'"]);
  });
});

describe("drafting a scenario with Claude", () => {
  it("isn't offered without an Anthropic API key", async () => {
    const pipeline = await pipelineOf("No key");
    const res = await call("POST", `/pipelines/${pipeline.id}/scenario-draft`, coordinator, { description: "Closed rows are left out." });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/enters an Anthropic API key on the operator panel/);
  });

  it("sends the pipeline's definitions, compiles the draft on the latest scan, and saves nothing", async () => {
    const briefs: DraftBrief[] = [];
    let answer: "draft" | "declined" | "unreachable" = "draft";
    const drafter: ScenarioDrafter = {
      available: async () => true,
      async draft(brief, request, compile) {
        briefs.push(brief);
        if (answer === "declined") throw new DraftFailed("Claude declined to draft this scenario.");
        if (answer === "unreachable") throw new Error("connect ECONNREFUSED");
        // A first answer with a misplaced check, as Claude might give before its correction.
        const scenario = { ...draft(request.name ?? "Drafted"), description: request.description };
        const wrong = compile({ ...scenario, expect: [{ checkpoint: "S.V_NOPE", assertions: [{ type: "row_count", equals: 1 }] }] });
        return { scenario, notes: ["Row 2 is closed."], problems: [...compile(scenario), ...wrong.map((p) => `first try: ${p}`)], usage: { input: 1, output: 1, cacheRead: 0 } };
      },
    };
    const withClaude = await buildServer({ db, queue: { send: async () => {} }, secrets: testSecrets, drafter }, { logger: false });
    const post = (url: string, as: TestUser, payload: object) => withClaude.inject({ method: "POST", url: `/api${url}`, headers: { cookie: as.cookie }, payload });
    try {
      const pipeline = await pipelineOf("Drafted");
      const inputs = () => withClaude.inject({ method: "GET", url: `/api/pipelines/${pipeline.id}/scenario-inputs`, headers: { cookie: viewer.cookie } }).then((r) => r.json());
      // The server has a key, but the account's admin hasn't agreed to send definitions to Anthropic yet.
      expect(await inputs()).toMatchObject({ drafting: false, draftingOff: "account" });
      const off = await post(`/pipelines/${pipeline.id}/scenario-draft`, coordinator, { description: "Closed rows are left out." });
      expect([off.statusCode, off.json().error]).toEqual([409, expect.stringMatching(/^Drafting with Claude is off for this account. An admin can switch it on under Settings/)]);
      const settings = (as: TestUser, draftingWithClaude: boolean) => withClaude.inject({ method: "PUT", url: "/api/account/settings", headers: { cookie: as.cookie }, payload: { draftingWithClaude } });
      expect((await settings(coordinator, true)).statusCode).toBe(403);
      expect((await settings(admin, true)).json()).toEqual({ draftingWithClaude: true });
      expect(await inputs()).toMatchObject({ drafting: true });
      expect((await inputs()).draftingOff).toBeUndefined();
      expect((await post(`/pipelines/${pipeline.id}/scenario-draft`, viewer, { description: "Closed rows are left out." })).statusCode).toBe(403);
      expect((await post(`/pipelines/${pipeline.id}/scenario-draft`, stranger, { description: "Closed rows are left out." })).statusCode).toBe(404);
      expect((await post(`/pipelines/${pipeline.id}/scenario-draft`, coordinator, { description: "  " })).json().issues[0].message).toBe("Describe the scenario first");
      expect(briefs).toEqual([]);

      const res = await post(`/pipelines/${pipeline.id}/scenario-draft`, coordinator, { description: "Closed rows are left out.", name: "Open rows" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ scenario: { name: "Open rows", description: "Closed rows are left out." }, notes: ["Row 2 is closed."], problems: ["first try: The check row_count = 1 on S.V_NOPE: S.V_NOPE isn't a step of the pipeline."] });
      // Definitions only: the columns with what the logic does with them, and each step's SQL.
      expect(briefs[0]).toMatchObject({ output: "S.V_OUT", tables: [{ technicalName: "LT_DATA", columns: expect.arrayContaining([{ name: "STATUS", type: "NVARCHAR(10)", used: true, keeps: "OPEN" }]) }] });
      expect(briefs[0]!.logic).toContain(`WHERE "STATUS" = 'OPEN'`);
      expect(briefs[0]!.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((await call("GET", `/pipelines/${pipeline.id}/scenarios`, viewer)).json()).toEqual([]);

      answer = "declined";
      const declined = await post(`/pipelines/${pipeline.id}/scenario-draft`, coordinator, { description: "Closed rows are left out." });
      expect([declined.statusCode, declined.json().error]).toEqual([502, "Claude declined to draft this scenario."]);
      answer = "unreachable";
      expect((await post(`/pipelines/${pipeline.id}/scenario-draft`, coordinator, { description: "Closed rows are left out." })).json().error).toMatch(/^Claude couldn't be reached/);

      // 50 drafts a day per account: the one above, and 49 more.
      const { rows } = await db.query<{ account_id: string }>("select account_id from tenants where id = $1", [pipeline.tenantId]);
      await db.query("insert into audit_events (account_id, action) select $1, 'POST /pipelines/:id/scenario-draft' from generate_series(1, 49)", [rows[0]!.account_id]);
      answer = "draft";
      const capped = await post(`/pipelines/${pipeline.id}/scenario-draft`, admin, { description: "Closed rows are left out." }); // the coordinator used their 5 a minute

      expect([capped.statusCode, capped.json().error]).toEqual([429, expect.stringMatching(/^This account drafted 50 scenarios with Claude in the last 24 hours/)]);
      expect(briefs).toHaveLength(3);
      await settings(admin, false);
    } finally {
      await withClaude.close();
    }
  });
});

describe("scenarios", () => {
  it("are saved by those who build tests, with a name unique per pipeline, and read by everyone in the account", async () => {
    const pipeline = await pipelineOf("Saved");
    expect((await call("POST", `/pipelines/${pipeline.id}/scenarios`, viewer, draft("Open rows"))).statusCode).toBe(403);
    const created = await call("POST", `/pipelines/${pipeline.id}/scenarios`, coordinator, draft("Open rows"));
    expect(created.statusCode).toBe(201);
    const scenario = created.json();
    // The pipeline comes from the saved pipeline, whatever the body says.
    expect(scenario).toMatchObject({ name: "Open rows", updatedBy: "coordinator@customer.example.com", spec: { pipeline: "S.V_OUT", version: 1 }, lastRun: null });
    expect((await call("POST", `/pipelines/${pipeline.id}/scenarios`, admin, draft("Open rows"))).json().error).toBe('This pipeline already has a scenario named "Open rows"');

    const updated = await call("PUT", `/scenarios/${scenario.id}`, admin, draft("Open rows only", { description: "Closed rows are left out." }));
    expect(updated.json()).toMatchObject({ name: "Open rows only", updatedBy: "admin@customer.example.com", spec: { description: "Closed rows are left out." } });
    expect((await call("GET", `/pipelines/${pipeline.id}/scenarios`, viewer)).json().map((s: { name: string }) => s.name)).toEqual(["Open rows only"]);
    expect((await call("GET", `/scenarios/${scenario.id}`, stranger)).statusCode).toBe(404);
    expect((await call("PUT", `/scenarios/${scenario.id}`, stranger, draft("Taken over"))).statusCode).toBe(404);

    expect((await call("DELETE", `/scenarios/${scenario.id}`, viewer)).statusCode).toBe(403);
    expect((await call("DELETE", `/scenarios/${scenario.id}`, coordinator)).statusCode).toBe(204);
    expect((await call("GET", `/scenarios/${scenario.id}`, admin)).statusCode).toBe(404);
  });

  it("are run by those who run tests, through the worker, once the tenant has a connected database user", async () => {
    const without = await pipelineOf("No database user");
    const lonely = (await call("POST", `/pipelines/${without.id}/scenarios`, admin, draft("Open rows"))).json();
    const refused = await call("POST", `/scenarios/${lonely.id}/runs`, admin);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/^A scenario runs its checks through a database user of the tenant/);

    const pipeline = await pipelineOf("Runs", true);
    const scenario = (await call("POST", `/pipelines/${pipeline.id}/scenarios`, admin, draft("Open rows"))).json();
    sent.length = 0;
    expect((await call("POST", `/scenarios/${scenario.id}/runs`, viewer)).statusCode).toBe(403);
    const res = await call("POST", `/scenarios/${scenario.id}/runs`, coordinator);
    expect(res.statusCode).toBe(202);
    const run = res.json();
    expect(run).toMatchObject({ scenarioId: scenario.id, status: "queued", spec: { name: "Open rows" }, requestedBy: "coordinator@customer.example.com" });
    expect(sent).toEqual([{ name: JOBS.scenarioRun, data: { runId: run.id } }]);

    // As the worker leaves it.
    await startScenarioRun(db, run.id, null);
    await finishScenarioRun(db, run.id, { status: "passed", steps: [], checks: [{ checkpoint: "S.V_OUT", label: "row_count = 1", status: "pass", detail: "1 row" }] });
    expect((await call("GET", `/scenarios/${scenario.id}/runs`, viewer)).json()).toMatchObject([{ id: run.id, status: "passed", passed: 1, total: 1 }]);
    expect((await call("GET", `/scenario-runs/${run.id}`, viewer)).json()).toMatchObject({ status: "passed", checks: [{ detail: "1 row" }] });
    expect((await call("GET", `/scenario-runs/${run.id}`, stranger)).statusCode).toBe(404);
    expect((await call("GET", `/pipelines/${pipeline.id}/scenarios`, viewer)).json()[0].lastRun).toMatchObject({ id: run.id, status: "passed" });
  });

  it("aren't run while a problem stops them, and say which", async () => {
    const pipeline = await pipelineOf("Problems", true);
    const scenario = (await call("POST", `/pipelines/${pipeline.id}/scenarios`, admin, { ...draft("Misplaced"), fixtures: [{ table: "S.LT_NOPE", rows: [] }] })).json();
    sent.length = 0;
    const res = await call("POST", `/scenarios/${scenario.id}/runs`, admin);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("The scenario can't run: The test rows for S.LT_NOPE name no table of the pipeline.");
    expect(sent).toEqual([]);
  });
});

describe("running all of a pipeline's scenarios", () => {
  it("queues a suite with a run of each scenario, which those who may run them start and everyone reads", async () => {
    const pipeline = await pipelineOf("Run all", true);
    expect((await call("POST", `/pipelines/${pipeline.id}/scenario-suites`, coordinator)).json()).toEqual({ error: "This pipeline has no scenarios yet" });
    for (const name of ["Open rows", "Closed rows"]) expect((await call("POST", `/pipelines/${pipeline.id}/scenarios`, coordinator, draft(name))).statusCode).toBe(201);

    sent.length = 0;
    const res = await call("POST", `/pipelines/${pipeline.id}/scenario-suites`, coordinator);
    expect(res.statusCode).toBe(202);
    const suite = res.json();
    expect(suite).toMatchObject({ cause: "manual", status: "queued", total: 2, requestedBy: "coordinator@customer.example.com", changed: [], alert: null });
    expect(suite.runs.map((r: { scenarioName: string; status: string }) => [r.scenarioName, r.status])).toEqual([
      ["Closed rows", "queued"],
      ["Open rows", "queued"],
    ]);
    expect(sent).toEqual([{ name: JOBS.scenarioSuite, data: { suiteId: suite.id } }]);
    // One at a time: the same scenarios again would only repeat the first.
    const twice = await call("POST", `/pipelines/${pipeline.id}/scenario-suites`, coordinator);
    expect([twice.statusCode, twice.json().error]).toEqual([409, "This pipeline's scenarios are still running. Run them again once they have finished."]);
    // A page at a time: older than the oldest is nothing.
    expect((await call("GET", `/pipelines/${pipeline.id}/scenario-suites?before=${encodeURIComponent(suite.requestedAt)}`, viewer)).json()).toEqual([]);

    expect((await call("GET", `/pipelines/${pipeline.id}/scenario-suites`, viewer)).json()).toEqual([expect.objectContaining({ id: suite.id, cause: "manual", total: 2 })]);
    expect((await call("GET", `/scenario-suites/${suite.id}`, viewer)).json()).toMatchObject({ id: suite.id, pipelineName: "Run all" });
    // Each run says which suite it ran in.
    expect((await call("GET", `/scenario-runs/${suite.runs[0].id}`, viewer)).json()).toMatchObject({ suiteId: suite.id });

    expect((await call("POST", `/pipelines/${pipeline.id}/scenario-suites`, viewer)).statusCode).toBe(403);
    expect((await call("GET", `/scenario-suites/${suite.id}`, stranger)).statusCode).toBe(404);
    expect((await call("POST", `/pipelines/${pipeline.id}/scenario-suites`, stranger)).statusCode).toBe(404);
  });

  it("is refused without a database user to run the checks with", async () => {
    const pipeline = await pipelineOf("Run all without a user");
    await call("POST", `/pipelines/${pipeline.id}/scenarios`, coordinator, draft("Open rows"));
    const res = await call("POST", `/pipelines/${pipeline.id}/scenario-suites`, coordinator);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/^A scenario runs its checks through a database user/);
  });
});
