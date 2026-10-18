import type { AlertReason, AlertStatus, SnapshotAlert, WatchState } from "@ystara/shared";
import type { Queryable } from "./db.js";

/** Watchers of pipelines and the alerts of scheduled snapshots (migration 009; the rules are in alerts.ts in @ystara/shared). */
export type { SnapshotAlert, WatchState };

export async function watchPipeline(db: Queryable, pipelineId: string, userId: string): Promise<void> {
  await db.query("insert into pipeline_watchers (pipeline_id, user_id) values ($1, $2) on conflict do nothing", [pipelineId, userId]);
}

export async function unwatchPipeline(db: Queryable, pipelineId: string, userId: string): Promise<void> {
  await db.query("delete from pipeline_watchers where pipeline_id = $1 and user_id = $2", [pipelineId, userId]);
}

/** Whether `userId` watches the pipeline, and how many of the account's members do. */
export async function watchState(db: Queryable, pipelineId: string, userId: string, accountId: string): Promise<WatchState> {
  const { rows } = await db.query<{ watching: boolean; watchers: number }>(
    `select coalesce(bool_or(w.user_id = $2), false) as watching, count(*)::int as watchers
       from pipeline_watchers w join memberships m on m.user_id = w.user_id and m.account_id = $3
      where w.pipeline_id = $1`,
    [pipelineId, userId, accountId],
  );
  return rows[0];
}

/** The email addresses of the pipeline's watchers who are still members of its account; nobody else ever gets its mail. */
export async function watcherEmails(db: Queryable, pipelineId: string): Promise<string[]> {
  const { rows } = await db.query<{ email: string }>(
    `select u.email
       from pipeline_watchers w
       join pipelines p on p.id = w.pipeline_id
       join tenants t on t.id = p.tenant_id
       join memberships m on m.user_id = w.user_id and m.account_id = t.account_id
       join users u on u.id = w.user_id
      where w.pipeline_id = $1
      order by u.email`,
    [pipelineId],
  );
  return rows.map((r) => r.email);
}

/** The pipeline's latest successful snapshot asked for before `before`, if any: what a scheduled snapshot is compared with. */
export async function previousSucceededSnapshotId(db: Queryable, pipelineId: string, before: Date): Promise<string | undefined> {
  const { rows } = await db.query<{ id: string }>(
    "select id from snapshots where pipeline_id = $1 and status = 'succeeded' and requested_at < $2 order by requested_at desc limit 1",
    [pipelineId, before],
  );
  return rows[0]?.id;
}

/** Records (or replaces) a snapshot's alert. */
export async function saveSnapshotAlert(
  db: Queryable,
  snapshotId: string,
  alert: { reasons: AlertReason[]; comparedWith: string | null; status: AlertStatus; recipients?: number; error?: string | null },
): Promise<void> {
  await db.query(
    `insert into snapshot_alerts (snapshot_id, compared_with, reasons, status, recipients, error, sent_at)
     values ($1, $2, $3::jsonb, $4, $5, $6, case when $4 = 'sent' then now() end)
     on conflict (snapshot_id) do update set compared_with = excluded.compared_with, reasons = excluded.reasons, status = excluded.status,
       recipients = excluded.recipients, error = excluded.error, sent_at = excluded.sent_at`,
    [snapshotId, alert.comparedWith, JSON.stringify(alert.reasons), alert.status, alert.recipients ?? 0, alert.error ?? null],
  );
}
