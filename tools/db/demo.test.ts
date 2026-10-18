import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, getSnapshotDetails, listPipelines, listTenants, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { compareSnapshots } from "@ystara/shared";
import { DEMO_COLUMNS, DEMO_NAMES, DEMO_SPACE, DEMO_TENANT, loadDemo } from "./demo.js";

let db: Db;
let accountId: string;
beforeAll(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterAll(async () => {
  await db.close();
});

describe("the demo tenant", () => {
  it("has names of 30, 40 and 50 characters, the longest Datasphere allows, in both styles", () => {
    const objects = Object.values(DEMO_NAMES).map((name) => name.length);
    const columns = [DEMO_COLUMNS.tracking, DEMO_COLUMNS.window, DEMO_COLUMNS.share].map((name) => name.length);
    expect(objects).toEqual(expect.arrayContaining([30, 40, 50]));
    expect(Math.max(...objects)).toBe(50);
    expect(columns).toEqual([30, 40, 50]);
    for (const name of Object.values(DEMO_NAMES)) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    for (const name of Object.values(DEMO_COLUMNS)) expect(name).toMatch(/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/);
  });

  it("loads a scan, a pipeline over the output and two snapshots that differ", async () => {
    const { tenant, pipeline, snapshots } = await loadDemo(db, accountId);
    expect(tenant).toMatchObject({ name: DEMO_TENANT, host: null });
    expect(pipeline.output).toEqual({ space: DEMO_SPACE, technicalName: DEMO_NAMES.output });
    expect(snapshots.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);

    const [before, after] = await Promise.all(snapshots.map((s) => getSnapshotDetails(db, s.id)));
    expect(before!.objects.map((o) => o.technicalName)).toEqual(
      expect.arrayContaining([DEMO_NAMES.loadFlow, DEMO_NAMES.rawTable, DEMO_NAMES.cleansedView, DEMO_NAMES.enrichFlow, DEMO_NAMES.enrichedTable, DEMO_NAMES.configTable, DEMO_NAMES.output]),
    );
    // Flows are processes; every table and view is measured.
    expect(before!.counts).toEqual({ measured: 5, notMeasurable: 2, failed: 0 });

    const comparison = compareSnapshots(before!, after!);
    const enriched = comparison.compared.find((o) => o.technicalName === DEMO_NAMES.enrichedTable)!;
    expect(enriched.verdict).toBe("data_changed");
    expect(enriched.columnsAdded).toEqual([DEMO_COLUMNS.added]);
    expect(comparison.compared.find((o) => o.technicalName === DEMO_NAMES.configTable)!.verdict).toBe("unchanged");
  });

  it("refuses to load it twice into one account, and adds nothing", async () => {
    const before = (await listTenants(db, accountId)).length;
    await expect(loadDemo(db, accountId)).rejects.toThrow(`already has the tenant "${DEMO_TENANT}"`);
    expect((await listTenants(db, accountId)).length).toBe(before);
    expect(await listPipelines(db, (await listTenants(db, accountId))[0].id)).toHaveLength(1);
  });
});
