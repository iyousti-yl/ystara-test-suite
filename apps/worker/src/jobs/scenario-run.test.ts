import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphFromRaw, type DatabaseUser, type Fragment, type RawObject, type Row } from "@ystara/connector";
import {
  createAccount,
  createPipeline,
  createScan,
  createScenario,
  createScenarioRun,
  createTenant,
  getDatabaseUserLogin,
  recordDatabaseCheck,
  saveScanResult,
  setDatabaseUser,
  type Db,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { ScenarioSpec } from "@ystara/shared";
import { databaseUserSecretContext, secretBox } from "@ystara/shared/secrets";
import { runScenarioRun, type ScenarioDatabase } from "./scenario-run.js";

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
const secrets = secretBox(randomBytes(32));
const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
  // The test database stands in for the tenant's: the checks read only DUMMY.
  await db.query(`create table dummy ("DUMMY" varchar(1))`);
  await db.query(`insert into dummy values ('X')`);
});
afterAll(async () => {
  await db.close();
});

const spec = (fixtures: object[], expect: object[]) => ScenarioSpec.parse({ version: 1, name: "Open rows", kind: "golden", pipeline: "S.V_OUT", fixtures, expect });
const rows = [{ table: "S.LT_DATA", rows: [{ ID: "1", STATUS: "OPEN", AMOUNT: 10.5 }, { ID: "2", STATUS: "CLOSED", AMOUNT: 3 }] }];

/** A scanned tenant with a saved pipeline for V_OUT, a run of `scenario` and connected database users of `spaces`. */
async function setUp(name: string, scenario: ScenarioSpec, spaces = ["S"]) {
  const tenant = await createTenant(db, { accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const scan = await createScan(db, tenant.id, ["S"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
  for (const space of spaces) {
    const sealedPassword = secrets.seal(`password of ${space}`, databaseUserSecretContext(tenant.id, space));
    await setDatabaseUser(db, { tenantId: tenant.id, space, host, user: `${space}#SYNTH`, sealedPassword, updatedBy: null });
    await recordDatabaseCheck(db, (await getDatabaseUserLogin(db, tenant.id, space))!, { visible: [] });
  }
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
  const stored = await createScenario(db, { tenantId: tenant.id, pipelineId: pipeline.id, spec: scenario, createdBy: null });
  return { scan, run: await createScenarioRun(db, stored, null) };
}

/** A stand-in for the tenant's database that runs each check on the test database, as PostgreSQL reads SAP HANA's SQL. */
function fakeDatabase() {
  const signIns: DatabaseUser[] = [];
  const sent: string[] = [];
  let closed = 0;
  const open = async (user: DatabaseUser): Promise<ScenarioDatabase> => {
    signIns.push(user);
    return {
      select: async (query: Fragment) => {
        sent.push(query.sql);
        let n = 0;
        const sql = query.sql.replace(/\?/g, () => `$${++n}`).replace(/NVARCHAR\(/g, "VARCHAR(");
        return (await db.query<Row>(sql, query.params)).rows;
      },
      close: async () => void closed++,
    };
  };
  return { open, signIns, sent, closed: () => closed };
}

describe("a scenario run", () => {
  it("sends each check through the output space's database user, on the scenario's rows only, and keeps what each gave back", async () => {
    const scenario = spec(rows, [{ checkpoint: "V_OUT", assertions: [{ type: "row_count", equals: 1 }, { type: "row_count", equals: 2 }] }]);
    const { scan, run } = await setUp("Production", scenario, ["T", "S"]);
    const fake = fakeDatabase();
    const done = await runScenarioRun(db, run.id, secrets, fake.open);
    expect(done).toMatchObject({ status: "failed", error: null, scanId: scan.id, passed: 1, total: 2 });
    expect(done?.checks).toEqual([
      { checkpoint: "V_OUT", label: "row_count = 1", status: "pass", detail: "1 row" },
      { checkpoint: "V_OUT", label: "row_count = 2", status: "fail", detail: "1 row, 2 expected" },
    ]);
    expect(done?.steps?.map((s) => [s.technicalName, s.note])).toEqual([
      ["LT_DATA", "fixture with 2 given rows"],
      ["V_OUT", "compiled from its SQL"],
    ]);
    // One sign-in, as the output space's user with its password opened, closed at the end; every check reads only DUMMY.
    expect(fake.signIns).toEqual([{ host, user: "S#SYNTH", password: "password of S" }]);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent.every((sql) => sql.includes("FROM DUMMY") && !/FROM\s+"/.test(sql))).toBe(true);
    expect(fake.closed()).toBe(1);
  });

  it("passes when every check passes, through any connected user when the output space has none", async () => {
    const { run } = await setUp("Elsewhere", spec(rows, [{ checkpoint: "V_OUT", assertions: [{ type: "row_count", equals: 1 }] }]), ["T"]);
    const fake = fakeDatabase();
    expect(await runScenarioRun(db, run.id, secrets, fake.open)).toMatchObject({ status: "passed", passed: 1, total: 1 });
    expect(fake.signIns.map((u) => u.user)).toEqual(["T#SYNTH"]);
  });

  it("is an error, without signing in, when the scenario has problems or the tenant has no connected user", async () => {
    const fake = fakeDatabase();
    const misplaced = await setUp("Misplaced", spec([{ table: "LT_NOPE", rows: [] }], [{ checkpoint: "V_OUT", assertions: [{ type: "row_count", equals: 0 }] }]));
    expect(await runScenarioRun(db, misplaced.run.id, secrets, fake.open)).toMatchObject({
      status: "error",
      error: "The scenario can't run: The fixture for LT_NOPE names no table of the pipeline.",
      checks: null,
    });
    const lonely = await setUp("No database user", spec(rows, [{ checkpoint: "V_OUT", assertions: [{ type: "row_count", equals: 1 }] }]), []);
    expect((await runScenarioRun(db, lonely.run.id, secrets, fake.open))?.error).toMatch(/^A scenario runs its checks through a database user of the tenant/);
    expect(fake.signIns).toEqual([]);
  });

  it("signs in only once when the sign-in fails, since repeated failures can lock the user", async () => {
    const twoChecks = [{ checkpoint: "V_OUT", assertions: [{ type: "row_count", equals: 1 }, { type: "unique", columns: ["ID"] }] }];
    const { run } = await setUp("Wrong password", spec(rows, twoChecks));
    let tries = 0;
    const done = await runScenarioRun(db, run.id, secrets, async () => {
      tries++;
      throw new Error("authentication failed\nat line 1");
    });
    expect(tries).toBe(1);
    expect(done).toMatchObject({ status: "error", error: "Signing in as S#SYNTH failed: authentication failed", passed: 0, total: 2 });
    expect(done?.checks?.map((c) => c.status)).toEqual(["error", "error"]);
  });

  it("runs once even if the job comes twice", async () => {
    const { run } = await setUp("Twice", spec(rows, [{ checkpoint: "V_OUT", assertions: [{ type: "row_count", equals: 1 }] }]));
    const fake = fakeDatabase();
    await runScenarioRun(db, run.id, secrets, fake.open);
    await runScenarioRun(db, run.id, secrets, fake.open);
    expect(fake.signIns).toHaveLength(1);
  });
});
