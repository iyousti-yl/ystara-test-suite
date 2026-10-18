import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, createPipeline, createTenant, finishSnapshot, getSchedule, listSnapshots, setNextRun, setSchedule, startSnapshot, type Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { runScheduleTick } from "./schedule-tick.js";

// A database per test: a tick takes every due schedule, whichever test made it.
let db: Db;
let accountId: string;
beforeEach(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
});
afterEach(async () => {
  await db.close();
});

/** A synthetic pipeline scheduled at 07:30 Brussels time on weekdays, next due at `nextRunAt`. */
async function scheduled(name: string, nextRunAt: Date) {
  const tenant = await createTenant(db, { accountId, name, host: "https://synthetic.eu10.hcs.cloud.sap" });
  const pipeline = await createPipeline(db, { tenantId: tenant.id, name, output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
  await setSchedule(db, { pipelineId: pipeline.id, cron: "30 7 * * 1-5", timeZone: "Europe/Brussels", nextRunAt, updatedBy: null });
  return pipeline;
}

/** Records the jobs a tick sends. */
function jobs() {
  const sent: string[] = [];
  return { sent, queue: async (snapshotId: string) => void sent.push(snapshotId) };
}

// Monday 19 October 2026, 07:30 in Brussels.
const monday0730 = new Date("2026-10-19T05:30:00Z");

describe("the schedule tick", () => {
  it("queues a scheduled snapshot when the run has come, and moves the next run on", async () => {
    const pipeline = await scheduled("Due", monday0730);
    const { sent, queue } = jobs();
    const result = await runScheduleTick(db, new Date("2026-10-19T05:30:20Z"), queue);

    expect(result).toEqual({ queued: 1, skipped: 0 });
    const [snapshot] = await listSnapshots(db, pipeline.id);
    expect(snapshot).toMatchObject({ status: "queued", scheduled: true });
    expect(sent).toEqual([snapshot.id]);
    expect((await getSchedule(db, pipeline.id))!.nextRunAt.toISOString()).toBe("2026-10-20T05:30:00.000Z");
  });

  it("does nothing before the run", async () => {
    const pipeline = await scheduled("Not yet", new Date("2026-10-26T06:30:00Z"));
    const { sent, queue } = jobs();
    await runScheduleTick(db, monday0730, queue);
    expect(await listSnapshots(db, pipeline.id)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("takes runs missed while the worker was stopped once, and plans the next from now", async () => {
    const pipeline = await scheduled("Missed", new Date("2026-10-12T05:30:00Z"));
    const { queue } = jobs();
    await runScheduleTick(db, new Date("2026-10-19T09:00:00Z"), queue);
    expect(await listSnapshots(db, pipeline.id)).toHaveLength(1);
    expect((await getSchedule(db, pipeline.id))!.nextRunAt.toISOString()).toBe("2026-10-20T05:30:00.000Z");
  });

  it("skips a run while the previous snapshot is unfinished, and takes the next once it has finished", async () => {
    const pipeline = await scheduled("Busy", monday0730);
    const { queue } = jobs();
    await runScheduleTick(db, monday0730, queue);
    const [first] = await listSnapshots(db, pipeline.id);
    await startSnapshot(db, first.id, null);

    // Half an hour later (as if the schedule ran every 30 minutes) the first one is still running.
    await setNextRun(db, pipeline.id, new Date("2026-10-19T06:00:00Z"));
    expect(await runScheduleTick(db, new Date("2026-10-19T06:00:00Z"), queue)).toEqual({ queued: 0, skipped: 1 });
    expect(await listSnapshots(db, pipeline.id)).toHaveLength(1);
    expect((await getSchedule(db, pipeline.id))!.nextRunAt.toISOString()).toBe("2026-10-20T05:30:00.000Z");

    await finishSnapshot(db, first.id, { status: "succeeded" });
    expect(await runScheduleTick(db, new Date("2026-10-20T05:30:00Z"), queue)).toEqual({ queued: 1, skipped: 0 });
  });

  it("does not wait for a snapshot that has been unfinished for more than two hours", async () => {
    const pipeline = await scheduled("Stuck", monday0730);
    const { queue } = jobs();
    await runScheduleTick(db, monday0730, queue);
    const [first] = await listSnapshots(db, pipeline.id);
    await startSnapshot(db, first.id, null);

    await setNextRun(db, pipeline.id, new Date("2026-10-19T07:31:00Z"));
    expect(await runScheduleTick(db, new Date("2026-10-19T07:31:00Z"), queue)).toEqual({ queued: 1, skipped: 0 });
    expect(await listSnapshots(db, pipeline.id)).toHaveLength(2);
  });

  it("skips a tenant made from imported scans: there is no database to measure", async () => {
    const tenant = await createTenant(db, { accountId, name: "Imported", host: null });
    const pipeline = await createPipeline(db, { tenantId: tenant.id, name: "Imported", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
    await setSchedule(db, { pipelineId: pipeline.id, cron: "30 7 * * 1-5", timeZone: "Europe/Brussels", nextRunAt: monday0730, updatedBy: null });
    expect(await runScheduleTick(db, monday0730, jobs().queue)).toEqual({ queued: 0, skipped: 1 });
    expect(await listSnapshots(db, pipeline.id)).toEqual([]);
    expect((await getSchedule(db, pipeline.id))!.nextRunAt.toISOString()).toBe("2026-10-20T05:30:00.000Z");
  });

  it("queues nothing when sending the job fails: the snapshot and the next run roll back together", async () => {
    const pipeline = await scheduled("Rolled back", monday0730);
    await expect(
      runScheduleTick(db, monday0730, async () => {
        throw new Error("queue down");
      }),
    ).rejects.toThrow("queue down");
    expect(await listSnapshots(db, pipeline.id)).toEqual([]);
    expect((await getSchedule(db, pipeline.id))!.nextRunAt.toISOString()).toBe(monday0730.toISOString());
  });
});
