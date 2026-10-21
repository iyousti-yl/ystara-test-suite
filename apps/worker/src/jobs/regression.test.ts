import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphFromRaw, type DatabaseUser, type Fragment, type RawObject, type Row } from "@ystara/connector";
import {
  createAccount,
  createPipeline,
  createScan,
  createScenario,
  createScenarioRun,
  createScenarioSuite,
  createTenant,
  finishScenarioRun,
  getConnectionLogin,
  getDatabaseUserLogin,
  getScan,
  getScenarioSuite,
  recordConnectionCheck,
  recordDatabaseCheck,
  saveScanResult,
  setConnection,
  setDatabaseUser,
  setScanSchedule,
  setTeamsChannel,
  watchPipeline,
  type Db,
  type Queryable,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { ScenarioSpec, type TeamsMessage } from "@ystara/shared";
import { connectionSecretContext, databaseUserSecretContext, secretBox, teamsChannelSecretContext } from "@ystara/shared/secrets";
import { queueSuitesAfterScan } from "./after-scan.js";
import type { AlertDelivery, AlertMail } from "./deliver.js";
import { runScenarioAlert } from "./scenario-alert.js";
import type { ScenarioDatabase } from "./scenario-run.js";
import { runScenarioSuite } from "./scenario-suite.js";
import { runScanScheduleTick } from "./schedule-tick.js";

// Synthetic space: V_OUT keeps the open rows of LT_DATA; a second version of V_OUT keeps the closed ones.
const elements = { ID: { type: "cds.String", length: 10 }, STATUS: { type: "cds.String", length: 10 } };
const view = (status: string): RawObject => ({
  space: "S",
  kind: "views",
  technicalName: "V_OUT",
  definition: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": `SELECT "ID" FROM "LT_DATA" WHERE "STATUS" = '${status}'`, elements } } },
});
const table: RawObject = { space: "S", kind: "local-tables", technicalName: "LT_DATA", definition: { definitions: { LT_DATA: { kind: "entity", elements } } } };
const OPEN = [table, view("OPEN")];
const CLOSED = [table, view("CLOSED")];

const secrets = secretBox(randomBytes(32));
const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";
const appUrl = "https://ystara.example";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await db.query(`create table dummy ("DUMMY" varchar(1))`);
  await db.query(`insert into dummy values ('X')`);
});
afterAll(async () => {
  await db.close();
});

const rows = [{ table: "S.LT_DATA", rows: [{ ID: "1", STATUS: "OPEN" }, { ID: "2", STATUS: "CLOSED" }] }];
const scenario = (name: string, id: string) =>
  ScenarioSpec.parse({ version: 1, name, kind: "golden", pipeline: "S.V_OUT", fixtures: rows, expect: [{ checkpoint: "V_OUT", assertions: [{ type: "rows_equal", key: ["ID"], rows: [{ ID: id }] }] }] });

async function scanned(tenantId: string, raw: RawObject[]) {
  const scan = await createScan(db, tenantId, ["S"]);
  return saveScanResult(db, scan.id, raw, graphFromRaw(raw, ["S"]));
}

/** A tenant scanned once (V_OUT keeps the open rows), a saved pipeline with two scenarios, a connected database user and a watcher. */
async function setUp(name: string, opts: { databaseUser?: boolean } = {}) {
  const account = await createAccount(db, `Account of ${name}`);
  const tenant = await createTenant(db, { accountId: account.id, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const first = await scanned(tenant.id, OPEN);
  if (opts.databaseUser ?? true) {
    const sealedPassword = secrets.seal("password of S", databaseUserSecretContext(tenant.id, "S"));
    await setDatabaseUser(db, { tenantId: tenant.id, space: "S", host, user: "S#SYNTH", sealedPassword, updatedBy: null });
    await recordDatabaseCheck(db, (await getDatabaseUserLogin(db, tenant.id, "S"))!, { visible: [] });
  }
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
  const keepsOpen = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: scenario("Open rows come through", "1"), createdBy: null });
  const keepsClosed = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: scenario("Closed rows come through", "2"), createdBy: null });
  return { account, tenant, first, pipeline, keepsOpen, keepsClosed };
}

/** The tenant's database, played by the test database: each check reads only DUMMY. */
function fakeDatabase() {
  const signIns: DatabaseUser[] = [];
  let closed = 0;
  const open = async (user: DatabaseUser): Promise<ScenarioDatabase> => {
    signIns.push(user);
    return {
      select: async (query: Fragment) => {
        let n = 0;
        const sql = query.sql.replace(/\?/g, () => `$${++n}`).replace(/NVARCHAR\(/g, "VARCHAR(");
        return (await db.query<Row>(sql, query.params)).rows;
      },
      close: async () => void closed++,
    };
  };
  return { open, signIns, closed: () => closed };
}

/** Records the jobs that would be sent, and on which transaction. */
function jobs() {
  const sent: { id: string; tx: Queryable }[] = [];
  return { sent, queue: async (id: string, tx: Queryable) => void sent.push({ id, tx }) };
}

describe("a suite", () => {
  it("runs every scenario of the pipeline through one sign-in, and fails when one fails", async () => {
    const { tenant, pipeline } = await setUp("Run all");
    const suite = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
    const fake = fakeDatabase();
    const done = await runScenarioSuite(db, suite.id, secrets, fake.open);
    expect(done).toMatchObject({ status: "failed", passed: 1, total: 2 });
    expect(done?.runs.map((r) => [r.scenarioName, r.status])).toEqual([
      ["Closed rows come through", "failed"],
      ["Open rows come through", "passed"],
    ]);
    expect(fake.signIns).toHaveLength(1);
    expect(fake.closed()).toBe(1);
    // Taken once.
    expect(await runScenarioSuite(db, suite.id, secrets, fake.open)).toMatchObject({ status: "failed" });
    expect(fake.signIns).toHaveLength(1);
  });

  it("doesn't sign in again for each scenario when the sign-in fails", async () => {
    const { tenant, pipeline } = await setUp("Locked");
    const suite = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
    let tries = 0;
    const done = await runScenarioSuite(db, suite.id, secrets, async () => {
      tries++;
      throw new Error("authentication failed");
    });
    expect(tries).toBe(1);
    expect(done).toMatchObject({ status: "failed", passed: 0, total: 2 });
    expect(done?.runs.every((r) => r.status === "error" && r.error === "Signing in as S#SYNTH failed: authentication failed")).toBe(true);
  });
});

describe("after a scan", () => {
  it("queues a suite for each pipeline whose steps changed, on the same transaction, and none when nothing did", async () => {
    const { tenant, pipeline } = await setUp("Changed");
    const same = await scanned(tenant.id, OPEN);
    const unchanged = jobs();
    expect(await queueSuitesAfterScan(db, same.id, unchanged.queue)).toEqual({ queued: 0, unchanged: 1, skipped: 0 });

    const changed = await scanned(tenant.id, CLOSED);
    const queued = jobs();
    expect(await queueSuitesAfterScan(db, changed.id, queued.queue)).toEqual({ queued: 1, unchanged: 0, skipped: 0 });
    const suite = await getScenarioSuite(db, queued.sent[0]!.id);
    expect(suite).toMatchObject({ cause: "scan", scanId: changed.id, pipelineId: pipeline.id, status: "queued", total: 2 });
    expect(suite?.changed).toEqual([{ space: "S", technicalName: "V_OUT", type: "sql_view", change: "definition" }]);
    expect(queued.sent[0]!.tx).not.toBe(db);

    // While it is queued, the next scan's changes wait for it.
    const again = await scanned(tenant.id, OPEN);
    expect(await queueSuitesAfterScan(db, again.id, jobs().queue)).toMatchObject({ queued: 0, skipped: 1 });
  });

  it("compares with the scan the scenarios last ran on, and leaves out imported scans and tenants without a database user", async () => {
    const { tenant, keepsOpen } = await setUp("Baseline");
    const changed = await scanned(tenant.id, CLOSED);
    // The scenarios already ran on the changed definitions: nothing new.
    const run = await createScenarioRun(db, keepsOpen, null);
    await db.query("update scenario_runs set scan_id = $2 where id = $1", [run.id, changed.id]);
    await finishScenarioRun(db, run.id, { status: "passed", checks: [] });
    const later = await scanned(tenant.id, CLOSED);
    expect(await queueSuitesAfterScan(db, later.id, jobs().queue)).toEqual({ queued: 0, unchanged: 1, skipped: 0 });

    const imported = await createScan(db, tenant.id, ["S"], "import");
    await saveScanResult(db, imported.id, OPEN, graphFromRaw(OPEN, ["S"]));
    expect(await queueSuitesAfterScan(db, imported.id, jobs().queue)).toEqual({ queued: 0, unchanged: 0, skipped: 0 });

    const lonely = await setUp("No database user", { databaseUser: false });
    expect(await queueSuitesAfterScan(db, (await scanned(lonely.tenant.id, CLOSED)).id, jobs().queue)).toEqual({ queued: 0, unchanged: 0, skipped: 1 });
  });
});

describe("a scenario alert", () => {
  /** Mail and Teams that record what they get; `teamsDown` makes the next posts fail. */
  function outbox() {
    const mails: AlertMail[] = [];
    const posts: { url: string; message: TeamsMessage }[] = [];
    let teamsDown = false;
    const delivery: AlertDelivery = {
      send: async (mail) => void mails.push(mail),
      appUrl,
      teams: {
        webhook: async (accountId) => {
          const { rows } = await db.query<{ sealed: string }>("select sealed from teams_channels where account_id = $1", [accountId]);
          return rows[0] && secrets.open(rows[0].sealed, teamsChannelSecretContext(accountId));
        },
        post: async (url, message) => {
          if (teamsDown) throw new Error("Teams refused the post (HTTP 404).");
          posts.push({ url, message });
        },
      },
    };
    return { mails, posts, delivery, setTeamsDown: (down: boolean) => (teamsDown = down) };
  }

  /** A suite after a scan that changed V_OUT, run: "Closed rows" passed before and fails now. */
  async function brokenSuite(name: string) {
    const setup = await setUp(name);
    const before = await createScenarioRun(db, setup.keepsClosed, null);
    await finishScenarioRun(db, before.id, { status: "passed", checks: [] });
    const scan = await scanned(setup.tenant.id, CLOSED);
    await new Promise((r) => setTimeout(r, 5));
    const suite = await createScenarioSuite(db, {
      tenantId: setup.tenant.id,
      pipelineId: setup.pipeline.id,
      cause: "scan",
      scanId: scan.id,
      changed: [{ space: "S", technicalName: "V_OUT", type: "sql_view", change: "definition" }],
      requestedBy: null,
    });
    await db.query("update scenario_runs set status = 'failed', checks = $2::jsonb, finished_at = now() where suite_id = $1 and scenario_id = $3", [
      suite.id,
      JSON.stringify([{ checkpoint: "V_OUT", label: "rows_equal on ID", status: "fail", detail: "" }]),
      setup.keepsClosed.id,
    ]);
    await db.query("update scenario_runs set status = 'passed', checks = '[]', finished_at = now() where suite_id = $1 and scenario_id = $2", [suite.id, setup.keepsOpen.id]);
    await db.query("update scenario_suites set status = 'failed', passed = 1, total = 2, finished_at = now() where id = $1", [suite.id]);
    return { ...setup, suite };
  }

  it("emails the watchers and posts in Teams about the scenarios that broke, names and labels only", async () => {
    const { account, pipeline, suite } = await brokenSuite("Broken");
    const { rows } = await db.query<{ id: string }>("insert into users (email, password_hash, totp_secret) values ('watcher@example.com', 'x', 'x') returning id");
    await db.query("insert into memberships (account_id, user_id, role) values ($1, $2, 'viewer')", [account.id, rows[0]!.id]);
    await watchPipeline(db, pipeline.id, rows[0]!.id);
    const webhook = "https://default0.00.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/1/triggers/manual/paths/invoke?sig=s";
    await setTeamsChannel(db, { accountId: account.id, sealed: secrets.seal(webhook, teamsChannelSecretContext(account.id)), host: "default0.00.environment.api.powerplatform.com", updatedBy: null });

    const out = outbox();
    const alert = await runScenarioAlert(db, suite.id, out.delivery);
    expect(alert).toMatchObject({
      status: "sent",
      recipients: 1,
      broken: [{ name: "Closed rows come through", status: "failed", failedChecks: ["rows_equal on ID"] }],
      teams: { status: "sent", error: null },
    });
    expect(out.mails).toHaveLength(1);
    expect(out.mails[0]).toMatchObject({ bcc: ["watcher@example.com"], subject: "[Ystara] A scenario broke: Broken" });
    expect(out.mails[0]!.text).toContain(`changed the pipeline "Broken": V_OUT (definition changed).`);
    expect(out.mails[0]!.text).toContain(`- "Closed rows come through" failed a check: rows_equal on ID.`);
    expect(out.mails[0]!.text).toContain(`${appUrl}/scenario-suites/${suite.id}`);
    expect(out.posts).toEqual([
      {
        url: webhook,
        message: expect.objectContaining({ title: "A scenario broke: Broken", link: { title: "Open the results", url: `${appUrl}/scenario-suites/${suite.id}` } }),
      },
    ]);
    // Never twice.
    await runScenarioAlert(db, suite.id, out.delivery);
    expect([out.mails.length, out.posts.length]).toEqual([1, 1]);
  });

  it("tries a failed Teams post again without sending the email again, and raises none for a suite started by hand", async () => {
    const { account, suite, tenant, pipeline } = await brokenSuite("Teams down");
    await setTeamsChannel(db, {
      accountId: account.id,
      sealed: secrets.seal("https://org.webhook.office.com/webhookb2/x", teamsChannelSecretContext(account.id)),
      host: "org.webhook.office.com",
      updatedBy: null,
    });
    const out = outbox();
    out.setTeamsDown(true);
    await expect(runScenarioAlert(db, suite.id, { ...out.delivery, send: null })).rejects.toThrow("HTTP 404");
    expect((await getScenarioSuite(db, suite.id))?.alert).toMatchObject({ status: "no_watchers", teams: { status: "failed", error: "Teams refused the post (HTTP 404)." } });
    out.setTeamsDown(false);
    expect(await runScenarioAlert(db, suite.id, out.delivery)).toMatchObject({ status: "no_watchers", teams: { status: "sent" } });
    expect(out.posts).toHaveLength(1);

    const byHand = await createScenarioSuite(db, { tenantId: tenant.id, pipelineId: pipeline.id, cause: "manual", requestedBy: null });
    await db.query("update scenario_suites set status = 'failed' where id = $1", [byHand.id]);
    expect(await runScenarioAlert(db, byHand.id, out.delivery)).toBeUndefined();
  });

  it("is none when every scenario that broke was already failing", async () => {
    const setup = await setUp("Already failing");
    const before = await createScenarioRun(db, setup.keepsClosed, null);
    await finishScenarioRun(db, before.id, { status: "failed", checks: [] });
    const other = await createScenarioRun(db, setup.keepsOpen, null);
    await finishScenarioRun(db, other.id, { status: "passed", checks: [] });
    await new Promise((r) => setTimeout(r, 5));
    const suite = await createScenarioSuite(db, { tenantId: setup.tenant.id, pipelineId: setup.pipeline.id, cause: "scan", requestedBy: null });
    await runScenarioSuite(db, suite.id, secrets, fakeDatabase().open);
    expect(await runScenarioAlert(db, suite.id, outbox().delivery)).toBeUndefined();
  });
});

describe("scan schedules", () => {
  it("queue a scheduled scan of the readable spaces when due, and skip a tenant without a technical client", async () => {
    const { tenant } = await setUp("Nightly");
    await setConnection(db, {
      tenantId: tenant.id,
      clientId: "sb-synthetic",
      sealedSecret: secrets.seal("secret", connectionSecretContext(tenant.id)),
      tokenUrl: "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token",
      spaces: ["S", "T"],
      updatedBy: null,
    });
    await recordConnectionCheck(db, (await getConnectionLogin(db, tenant.id))!, {
      spaces: [
        { space: "S", readable: true, error: null },
        { space: "T", readable: false, error: "not a member" },
      ],
    });
    await setScanSchedule(db, { tenantId: tenant.id, cron: "0 2 * * *", timeZone: "Europe/Brussels", nextRunAt: new Date("2026-10-21T00:00:00Z"), updatedBy: null });
    const lonely = await setUp("No client");
    await setScanSchedule(db, { tenantId: lonely.tenant.id, cron: "0 2 * * *", timeZone: "Europe/Brussels", nextRunAt: new Date("2026-10-21T00:00:00Z"), updatedBy: null });

    const sent = jobs();
    expect(await runScanScheduleTick(db, new Date("2026-10-21T00:00:30Z"), sent.queue)).toEqual({ queued: 1, skipped: 1 });
    expect(await getScan(db, sent.sent[0]!.id)).toMatchObject({ tenantId: tenant.id, spaces: ["S"], status: "queued", scheduled: true });
    // The next run moved to the next night, so the next tick has nothing to do.
    expect(await runScanScheduleTick(db, new Date("2026-10-21T00:01:30Z"), sent.queue)).toEqual({ queued: 0, skipped: 0 });
  });
});
