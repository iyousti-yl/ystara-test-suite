import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphFromRaw, type DatabaseUser, type ObjectMeasures, type RawObject } from "@ystara/connector";
import {
  createAccount,
  createPipeline,
  createScan,
  createSnapshot,
  createTenant,
  getDatabaseUserLogin,
  getSnapshotDetails,
  recordDatabaseCheck,
  saveScanResult,
  setDatabaseUser,
  type Db,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { databaseUserSecretContext, secretBox } from "@ystara/shared/secrets";
import { runSnapshot, type SnapshotDatabase } from "./snapshot.js";

// Synthetic space: DF_LOAD loads LT_DATA, V_MID reads it, V_OUT reads V_MID.
const producer = (table: string) => ({ component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: table } } });
const RAW: RawObject[] = [
  { space: "S", kind: "local-tables", technicalName: "LT_SRC", definition: { definitions: { LT_SRC: { kind: "entity" } } } },
  { space: "S", kind: "local-tables", technicalName: "LT_DATA", definition: { definitions: { LT_DATA: { kind: "entity" } } } },
  {
    space: "S",
    kind: "data-flows",
    technicalName: "DF_LOAD",
    definition: {
      dataflows: {
        DF_LOAD: { contents: { processes: { consumer1: { component: "com.sap.database.table.consumer", metadata: { config: { dwcEntity: "LT_SRC" } } }, producer1: producer("LT_DATA") } } },
      },
    },
  },
  { space: "S", kind: "views", technicalName: "V_MID", definition: { definitions: { V_MID: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "LT_DATA"' } } } },
  { space: "S", kind: "views", technicalName: "V_OUT", definition: { definitions: { V_OUT: { kind: "entity", "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "V_MID"' } } } },
];

const secrets = secretBox(randomBytes(32));
const host = "synthetic.hana.prod-eu10.hanacloud.ondemand.com";
const measures = (rows: number): ObjectMeasures => ({ rows, columns: [{ name: "AMOUNT", dataType: "DECIMAL", nonNull: rows, distinct: 3, minHash: "aa", maxHash: "bb", sum: "10", sumHash: null }] });

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterAll(async () => {
  await db.close();
});

/** A tenant with a scan of space S, a saved pipeline for V_OUT, and a database user of S that sees `visible`. */
async function setUp(name: string, visible: string[] | null = ["V_MID", "V_OUT"]) {
  const tenant = await createTenant(db, { accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const scan = await createScan(db, tenant.id, ["S"], "import");
  await saveScanResult(db, scan.id, RAW, graphFromRaw(RAW, ["S"]));
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
  if (visible) {
    const sealedPassword = secrets.seal("synthetic-password", databaseUserSecretContext(tenant.id, "S"));
    await setDatabaseUser(db, { tenantId: tenant.id, space: "S", host, user: "S#SYNTH", sealedPassword, updatedBy: null });
    await recordDatabaseCheck(db, (await getDatabaseUserLogin(db, tenant.id, "S"))!, { visible: visible.map((v) => ({ name: v, type: "VIEW" as const })) });
  }
  return { tenant, scan, pipeline, snapshot: () => createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null }) };
}

/** A stand-in for the database: records sign-ins and what it measured. */
function fakeDatabase(measure: (name: string) => ObjectMeasures | Error = () => measures(24)) {
  const signIns: { user: DatabaseUser; space: string; salt: string }[] = [];
  const measured: string[] = [];
  let closed = 0;
  const open = async (user: DatabaseUser, space: string, salt: string): Promise<SnapshotDatabase> => {
    signIns.push({ user, space, salt });
    return {
      measure: async (object) => {
        measured.push(`${object.type} ${object.name}`);
        const result = measure(object.name);
        if (result instanceof Error) throw result;
        return result;
      },
      close: async () => void closed++,
    };
  };
  return { open, signIns, measured, closed: () => closed };
}

describe("a snapshot", () => {
  it("measures what the space's database user sees, says why for every other step, and keeps each definition's hash", async () => {
    const { scan, snapshot } = await setUp("Production");
    const fake = fakeDatabase();
    const done = await runSnapshot(db, (await snapshot()).id, secrets, fake.open);
    expect(done).toMatchObject({ status: "succeeded", error: null, scanId: scan.id, counts: { measured: 2, notMeasurable: 3, failed: 0 } });

    const details = (await getSnapshotDetails(db, done!.id))!;
    expect(details.objects.map((o) => [o.technicalName, o.status, o.reason])).toEqual([
      ["LT_SRC", "not_measurable", "not-visible"],
      ["DF_LOAD", "not_measurable", "process"],
      ["LT_DATA", "not_measurable", "not-visible"],
      ["V_MID", "measured", null],
      ["V_OUT", "measured", null],
    ]);
    expect(details.objects.find((o) => o.technicalName === "V_OUT")).toMatchObject({ rows: 24, columns: measures(24).columns });
    expect(details.objects.every((o) => o.definitionHash)).toBe(true);

    // One sign-in for the space, with the password opened, and closed at the end.
    expect(fake.signIns).toHaveLength(1);
    expect(fake.signIns[0]).toMatchObject({ user: { host, user: "S#SYNTH", password: "synthetic-password" }, space: "S" });
    expect(fake.signIns[0].salt).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.measured).toEqual(["VIEW V_MID", "VIEW V_OUT"]);
    expect(fake.closed()).toBe(1);
  });

  it("uses the same salt for the tenant every time, and another one for another tenant", async () => {
    const first = await setUp("Salt one");
    const second = await setUp("Salt two");
    const fake = fakeDatabase();
    await runSnapshot(db, (await first.snapshot()).id, secrets, fake.open);
    await runSnapshot(db, (await first.snapshot()).id, secrets, fake.open);
    await runSnapshot(db, (await second.snapshot()).id, secrets, fake.open);
    const [a, b, c] = fake.signIns.map((s) => s.salt);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("fails when a measurable step couldn't be measured, and keeps the others", async () => {
    const { snapshot } = await setUp("One fails");
    const fake = fakeDatabase((name) => (name === "V_MID" ? new Error("invalid column name: AMOUNT\nat line 1") : measures(24)));
    const done = await runSnapshot(db, (await snapshot()).id, secrets, fake.open);
    expect(done).toMatchObject({ status: "failed", error: "1 of 2 measurable steps couldn't be measured. Each one says why.", counts: { measured: 1, failed: 1 } });
    const details = (await getSnapshotDetails(db, done!.id))!;
    expect(details.objects.find((o) => o.technicalName === "V_MID")).toMatchObject({ status: "failed", reason: "invalid column name: AMOUNT" });
  });

  it("signs in only once when the sign-in fails, since repeated failures can lock the user", async () => {
    const { snapshot } = await setUp("Wrong password");
    let tries = 0;
    const done = await runSnapshot(db, (await snapshot()).id, secrets, async () => {
      tries++;
      throw new Error("authentication failed");
    });
    expect(tries).toBe(1);
    expect(done).toMatchObject({ status: "failed", counts: { measured: 0, failed: 2 } });
    const details = (await getSnapshotDetails(db, done!.id))!;
    expect(details.objects.find((o) => o.technicalName === "V_OUT")?.reason).toBe("Signing in as S#SYNTH failed: authentication failed");
  });

  it("fails, saying why for each step, when nothing can be measured", async () => {
    const { snapshot } = await setUp("No database user", null);
    const fake = fakeDatabase();
    const done = await runSnapshot(db, (await snapshot()).id, secrets, fake.open);
    expect(done).toMatchObject({ status: "failed", error: "None of this pipeline's steps can be measured with SQL. Each one says why.", counts: { notMeasurable: 5 } });
    expect(fake.signIns).toEqual([]);
  });

  it("fails without a successful scan, and runs once even if the job comes twice", async () => {
    const tenant = await createTenant(db, { accountId, name: "Never scanned", host: "https://synthetic.eu10.hcs.cloud.sap" });
    const pipeline = await createPipeline(db, { tenantId: tenant.id, name: "Early", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
    const queued = await createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null });
    expect(await runSnapshot(db, queued.id, secrets, fakeDatabase().open)).toMatchObject({ status: "failed", error: "This tenant has no successful scan yet" });

    const { snapshot } = await setUp("Twice");
    const fake = fakeDatabase();
    const id = (await snapshot()).id;
    await runSnapshot(db, id, secrets, fake.open);
    await runSnapshot(db, id, secrets, fake.open);
    expect(fake.signIns).toHaveLength(1);
  });
});
