import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secretBox } from "@ystara/shared/secrets";
import { createAccount } from "./accounts.js";
import type { Db } from "./db.js";
import { createPipeline } from "./pipelines.js";
import { createScan, getScan } from "./scans.js";
import { assertMasterKey } from "./server-secrets.js";
import { createSnapshot, getSnapshot } from "./snapshots.js";
import { sweepInterrupted, type LiveJobs } from "./sweep.js";
import { createTenant } from "./tenants.js";
import { createTestDb } from "./testing.js";
import { lastHeartbeat, recordHeartbeat } from "./workers.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const testSecretBox = () => secretBox(randomBytes(32));
const none = (): LiveJobs => ({ scans: new Set(), snapshots: new Set(), suites: new Set(), runs: new Set(), connectionChecks: new Set(), databaseChecks: new Set() });
const age = (table: string, id: string, minutes: number) => db.query(`update ${table} set requested_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);

describe("rows a stopped worker left behind", () => {
  it("are marked as interrupted when pg-boss holds no job for them, and only then", async () => {
    const account = await createAccount(db, "Sweep");
    const tenant = await createTenant(db, { accountId: account.id, name: "Sweep", host: "https://synthetic.eu10.hcs.cloud.sap" });
    const pipeline = await createPipeline(db, { tenantId: tenant.id, name: "Sweep", output: { space: "SALES", technicalName: "V_OUT" }, excludeWriters: [] });
    const orphan = await createScan(db, tenant.id, ["SALES"]);
    const held = await createScan(db, tenant.id, ["SALES"]);
    const fresh = await createScan(db, tenant.id, ["SALES"]);
    const snapshot = await createSnapshot(db, { tenantId: tenant.id, pipelineId: pipeline.id, requestedBy: null });
    await db.query("update scans set status = 'running' where id = $1", [orphan.id]);
    await age("scans", orphan.id, 30);
    await age("scans", held.id, 30);
    await age("snapshots", snapshot.id, 30);

    const live = none();
    live.scans.add(held.id);
    expect(await sweepInterrupted(db, live)).toMatchObject({ scans: 1, snapshots: 1 });
    expect(await getScan(db, orphan.id)).toMatchObject({ status: "failed", error: "The scan stopped: Ystara restarted while it ran. Start it again." });
    expect((await getScan(db, held.id))?.status).toBe("queued"); // its job still waits
    expect((await getScan(db, fresh.id))?.status).toBe("queued"); // saved a moment ago: its job may be on its way
    expect((await getSnapshot(db, snapshot.id))?.status).toBe("failed");

    // A second sweep finds nothing more.
    expect(await sweepInterrupted(db, live)).toMatchObject({ scans: 0, snapshots: 0 });
  });
});

describe("the worker's sign of life", () => {
  it("keeps the newest tick", async () => {
    expect(await lastHeartbeat(db)).toBeUndefined();
    await recordHeartbeat(db, { worker: "host:1", version: "abc1234", startedAt: new Date() });
    expect(await lastHeartbeat(db)).toMatchObject({ version: "abc1234" });
  });
});

describe("the master key check", () => {
  it("is sealed by the first program to start, and stops one with another key", async () => {
    const key = testSecretBox();
    await assertMasterKey(db, key);
    await expect(assertMasterKey(db, key)).resolves.toBeUndefined();
    await expect(assertMasterKey(db, testSecretBox())).rejects.toThrow(/not the key this database's secrets were sealed with/);
  });
});
