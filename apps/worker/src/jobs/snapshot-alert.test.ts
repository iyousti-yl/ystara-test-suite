import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  createPipeline,
  createSnapshot,
  createTenant,
  finishSnapshot,
  getSnapshot,
  saveSnapshotObject,
  setSchedule,
  startSnapshot,
  watchPipeline,
  type Db,
} from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { ColumnMeasures } from "@ystara/shared";
import { runSnapshotAlert, type AlertMail } from "./snapshot-alert.js";

// A database per test, with a synthetic account, tenant and pipeline over S.V_OUT.
let db: Db;
let accountId: string;
let pipeline: { id: string; tenantId: string };
beforeEach(async () => {
  db = await createTestDb();
  accountId = (await createAccount(db, "Synthetic customer")).id;
  const tenant = await createTenant(db, { accountId, name: "Synthetic tenant", host: "https://synthetic.eu10.hcs.cloud.sap" });
  pipeline = await createPipeline(db, { tenantId: tenant.id, name: "Synthetic pipeline", output: { space: "S", technicalName: "V_OUT" }, excludeWriters: [] });
  await setSchedule(db, { pipelineId: pipeline.id, cron: "30 7 * * 1-5", timeZone: "Europe/Brussels", nextRunAt: new Date("2026-10-20T05:30:00Z"), updatedBy: null });
});
afterEach(async () => {
  await db.close();
});

/** A user, a member of `account` (the test account unless given), watching the pipeline. */
async function watcher(email: string, account = accountId) {
  const { rows } = await db.query<{ id: string }>("insert into users (email, password_hash, totp_secret) values ($1, 'x', 'x') returning id", [email]);
  await db.query("insert into memberships (account_id, user_id, role) values ($1, $2, 'viewer')", [account, rows[0].id]);
  await watchPipeline(db, pipeline.id, rows[0].id);
}

// A sum no email may ever show: values stay in the database.
const SECRET_SUM = "987654321";
const column: ColumnMeasures = { name: "AMOUNT", dataType: "DECIMAL", nonNull: 9, distinct: 9, minHash: "f".repeat(64), maxHash: "e".repeat(64), sum: SECRET_SUM, sumHash: null, sumScale: 2 };

/** A finished snapshot of V_OUT with `rows` rows, asked for at `at`. */
async function taken(rows: number, at: string, o: { scheduled?: boolean; status?: "succeeded" | "failed" } = {}) {
  const snapshot = await createSnapshot(db, { tenantId: pipeline.tenantId, pipelineId: pipeline.id, requestedBy: null, scheduled: o.scheduled ?? true, requestedAt: new Date(at) });
  await startSnapshot(db, snapshot.id, null);
  await saveSnapshotObject(db, snapshot.id, 0, { space: "S", technicalName: "V_OUT", type: "sql_view", definitionHash: "h", status: "measured", reason: null, rows, columns: [column], tookMs: 3 });
  await finishSnapshot(db, snapshot.id, { status: o.status ?? "succeeded" });
  return snapshot;
}

/** Records the emails sent. */
function mailbox() {
  const sent: AlertMail[] = [];
  return { sent, send: async (mail: AlertMail) => void sent.push(mail) };
}
const appUrl = "http://127.0.0.1:4000/";

describe("the alert job", () => {
  it("emails the watchers who are members of the account, once, with names, counts and links", async () => {
    await watcher("first@customer.example.com");
    await watcher("second@customer.example.com");
    await watcher("outsider@elsewhere.example.com", (await createAccount(db, "Elsewhere")).id);
    const before = await taken(1000, "2026-10-19T05:30:00Z");
    const after = await taken(600, "2026-10-20T05:30:00Z");
    const { sent, send } = mailbox();

    const alert = await runSnapshotAlert(db, after.id, { send, appUrl });
    expect(alert).toMatchObject({ status: "sent", recipients: 2, comparedWith: before.id, error: null });
    expect(alert!.reasons).toEqual([{ kind: "output_dropped", step: "V_OUT", rowsBefore: 1000, rowsAfter: 600, percent: 40, threshold: 20 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].bcc).toEqual(["first@customer.example.com", "second@customer.example.com"]);
    expect(sent[0].subject).toBe("[Ystara] Output down 40%: Synthetic pipeline");
    expect(sent[0].text).toContain('The scheduled snapshot of the pipeline "Synthetic pipeline" in the tenant "Synthetic tenant", taken Tue 20 Oct, 07:30 (Europe/Brussels time)');
    expect(sent[0].text).toContain("- The output V_OUT lost 40% of its rows: 1,000 before, 600 now. Alerts start above 20%.");
    expect(sent[0].text).toContain(`http://127.0.0.1:4000/pipelines/${pipeline.id}/compare?from=${before.id}&to=${after.id}`);
    expect(sent[0].text).toContain(`http://127.0.0.1:4000/snapshots/${after.id}`);
    expect(sent[0].text).not.toContain(SECRET_SUM);
    expect(sent[0].text).not.toContain("f".repeat(8));

    // Run again (a retried job): nothing is sent twice.
    expect(await runSnapshotAlert(db, after.id, { send, appUrl })).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect((await getSnapshot(db, after.id))!.alert).toMatchObject({ status: "sent", recipients: 2 });
  });

  it("raises nothing when nothing calls for an alert, or for a snapshot taken by hand", async () => {
    await watcher("first@customer.example.com");
    await taken(1000, "2026-10-19T05:30:00Z");
    const steady = await taken(950, "2026-10-20T05:30:00Z");
    const byHand = await taken(0, "2026-10-20T09:00:00Z", { scheduled: false });
    const { sent, send } = mailbox();
    expect(await runSnapshotAlert(db, steady.id, { send, appUrl })).toBeUndefined();
    expect(await runSnapshotAlert(db, byHand.id, { send, appUrl })).toBeUndefined();
    expect(sent).toEqual([]);
    expect((await getSnapshot(db, steady.id))!.alert).toBeNull();
  });

  it("records an alert it could not email: nobody watches, or no mail server is set", async () => {
    const failed = await taken(0, "2026-10-19T05:30:00Z", { status: "failed" });
    expect(await runSnapshotAlert(db, failed.id, { send: mailbox().send, appUrl })).toMatchObject({ status: "no_watchers", recipients: 0, comparedWith: null });

    await watcher("first@customer.example.com");
    const again = await taken(0, "2026-10-20T05:30:00Z", { status: "failed" });
    expect(await runSnapshotAlert(db, again.id, { send: null, appUrl })).toMatchObject({ status: "no_mail_server", reasons: [{ kind: "failed", steps: [] }] });
  });

  it("records a failed send and throws, so the job is tried again; the next try sends it", async () => {
    await watcher("first@customer.example.com");
    await taken(1000, "2026-10-19T05:30:00Z");
    const empty = await taken(0, "2026-10-20T05:30:00Z");
    const down = async () => {
      throw new Error("Connection refused\nat the mail server");
    };
    await expect(runSnapshotAlert(db, empty.id, { send: down, appUrl })).rejects.toThrow("Connection refused");
    expect((await getSnapshot(db, empty.id))!.alert).toMatchObject({ status: "failed", error: "Connection refused", reasons: [{ kind: "output_empty" }] });

    const { sent, send } = mailbox();
    expect(await runSnapshotAlert(db, empty.id, { send, appUrl })).toMatchObject({ status: "sent", recipients: 1, error: null });
    expect(sent[0].subject).toBe("[Ystara] Output empty: Synthetic pipeline");
  });
});
