import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SnapshotObject } from "@ystara/shared";
import { createAccount } from "./accounts.js";
import type { Db } from "./db.js";
import { createPipeline, deletePipeline } from "./pipelines.js";
import { createSnapshot, finishSnapshot, getSnapshot, getSnapshotDetails, listSnapshots, saveSnapshotObject, snapshotSalt, startSnapshot } from "./snapshots.js";
import { createTenant } from "./tenants.js";
import { createTestDb } from "./testing.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function newPipeline(name: string) {
  const account = await createAccount(db, `Account of ${name}`);
  const tenant = await createTenant(db, { accountId: account.id, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "SALES", technicalName: "ORDERS_SYNTH_V" }, excludeWriters: [] });
  return { tenant, pipeline };
}
const measured: SnapshotObject = {
  space: "SALES",
  technicalName: "ORDERS_SYNTH_V",
  type: "sql_view",
  definitionHash: "h1",
  status: "measured",
  reason: null,
  rows: 24,
  columns: [{ name: "AMOUNT", dataType: "DECIMAL", nonNull: 20, distinct: 7, minHash: "03", maxHash: "04", sum: "1234.50", sumHash: null }],
  tookMs: 120,
};
const table: SnapshotObject = { ...measured, technicalName: "ORDERS_SYNTH", type: "local_table", status: "not_measurable", reason: "not-visible", rows: null, columns: null, tookMs: null };

describe("snapshots", () => {
  it("go from queued to running to finished, with each step in pipeline order and counts per result", async () => {
    const { tenant, pipeline } = await newPipeline("Production");
    const snapshot = await createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null });
    expect(snapshot).toMatchObject({ status: "queued", scanId: null, counts: { measured: 0, notMeasurable: 0, failed: 0 } });

    expect(await startSnapshot(db, snapshot.id, null)).toBe(true);
    expect(await startSnapshot(db, snapshot.id, null)).toBe(false); // taken already
    await saveSnapshotObject(db, snapshot.id, 1, measured);
    await saveSnapshotObject(db, snapshot.id, 0, table);
    await finishSnapshot(db, snapshot.id, { status: "succeeded" });

    const details = (await getSnapshotDetails(db, snapshot.id))!;
    expect(details).toMatchObject({ status: "succeeded", error: null, counts: { measured: 1, notMeasurable: 1, failed: 0 } });
    expect(details.objects).toEqual([table, measured]);
    expect(details.startedAt).not.toBeNull();
    expect(details.finishedAt).not.toBeNull();
  });

  it("are listed newest first, and go with their pipeline", async () => {
    const { tenant, pipeline } = await newPipeline("Several");
    const first = await createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null });
    const second = await createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null });
    await db.query("update snapshots set requested_at = requested_at - interval '1 minute' where id = $1", [first.id]);
    expect((await listSnapshots(db, pipeline.id)).map((s) => s.id)).toEqual([second.id, first.id]);

    await deletePipeline(db, pipeline.id);
    expect(await getSnapshot(db, first.id)).toBeUndefined();
  });
});

describe("a tenant's snapshot salt", () => {
  it("is made once and never replaced", async () => {
    const { tenant } = await newPipeline("Salted");
    let sealed = 0;
    const seal = () => `v1.salt-${++sealed}`;
    expect(await snapshotSalt(db, tenant.id, seal)).toBe("v1.salt-1");
    expect(await snapshotSalt(db, tenant.id, seal)).toBe("v1.salt-1");
    expect(sealed).toBe(1);
  });

  it("stays the first one stored when two workers make one at the same moment", async () => {
    const { tenant } = await newPipeline("Raced");
    const [a, b] = await Promise.all([snapshotSalt(db, tenant.id, () => "v1.a"), snapshotSalt(db, tenant.id, () => "v1.b")]);
    expect(a).toBe(b);
  });
});
