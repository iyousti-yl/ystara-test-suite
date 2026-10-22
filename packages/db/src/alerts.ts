import type { AlertReason, AlertStatus, BrokenScenario, ScenarioAlert, SnapshotAlert, TeamsChannel, TeamsDelivery, WatchState } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Watchers of pipelines, the alerts of scheduled snapshots (migration 009) and
 * of suites after a scan, and each account's Teams channel (migration 013).
 * The rules are in alerts.ts in @ystara/shared.
 */
export type { ScenarioAlert, SnapshotAlert, TeamsChannel, WatchState };

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
       from pipeline_watchers w
       join pipelines p on p.id = w.pipeline_id
       join memberships m on m.user_id = w.user_id and m.account_id = $3
      where w.pipeline_id = $1 and (m.role = 'admin' or m.spaces is null or p.output_space = any(m.spaces))`,
    [pipelineId, userId, accountId],
  );
  return rows[0];
}

/**
 * The email addresses of the pipeline's watchers who are still members of its account and still see its output's
 * space (an admin, or a member not limited to other spaces); nobody else ever gets its mail.
 */
export async function watcherEmails(db: Queryable, pipelineId: string): Promise<string[]> {
  const { rows } = await db.query<{ email: string }>(
    `select u.email
       from pipeline_watchers w
       join pipelines p on p.id = w.pipeline_id
       join tenants t on t.id = p.tenant_id
       join memberships m on m.user_id = w.user_id and m.account_id = t.account_id
       join users u on u.id = w.user_id
      where w.pipeline_id = $1 and (m.role = 'admin' or m.spaces is null or p.output_space = any(m.spaces))
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

/** Records how posting a snapshot's alert in Teams went; null when the account has no channel. */
export async function saveSnapshotAlertTeams(db: Queryable, snapshotId: string, delivery: TeamsDelivery | null): Promise<void> {
  await db.query("update snapshot_alerts set teams_status = $2, teams_error = $3 where snapshot_id = $1", [snapshotId, delivery?.status ?? null, delivery?.error ?? null]);
}

/** Records (or replaces) a suite's alert, keeping how its Teams post went. */
export async function saveScenarioAlert(
  db: Queryable,
  suiteId: string,
  alert: { broken: BrokenScenario[]; status: AlertStatus; recipients?: number; error?: string | null },
): Promise<void> {
  await db.query(
    `insert into scenario_alerts (suite_id, broken, status, recipients, error, sent_at)
     values ($1, $2::jsonb, $3, $4, $5, case when $3 = 'sent' then now() end)
     on conflict (suite_id) do update set broken = excluded.broken, status = excluded.status, recipients = excluded.recipients,
       error = excluded.error, sent_at = excluded.sent_at`,
    [suiteId, JSON.stringify(alert.broken), alert.status, alert.recipients ?? 0, alert.error ?? null],
  );
}

export async function saveScenarioAlertTeams(db: Queryable, suiteId: string, delivery: TeamsDelivery | null): Promise<void> {
  await db.query("update scenario_alerts set teams_status = $2, teams_error = $3 where suite_id = $1", [suiteId, delivery?.status ?? null, delivery?.error ?? null]);
}

/** The account's Teams channel as the app shows it (never the address), or undefined. */
export async function getTeamsChannel(db: Queryable, accountId: string): Promise<TeamsChannel | undefined> {
  const { rows } = await db.query<{ host: string; updated_at: Date; email: string | null }>(
    "select c.host, c.updated_at, u.email from teams_channels c left join users u on u.id = c.updated_by where c.account_id = $1",
    [accountId],
  );
  return rows[0] && { host: rows[0].host, updatedAt: rows[0].updated_at, updatedBy: rows[0].email };
}

/** The sealed webhook address the worker posts to, or undefined. */
export async function getTeamsWebhook(db: Queryable, accountId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ sealed: string }>("select sealed from teams_channels where account_id = $1", [accountId]);
  return rows[0]?.sealed;
}

export async function setTeamsChannel(db: Queryable, input: { accountId: string; sealed: string; host: string; updatedBy: string | null }): Promise<void> {
  await db.query(
    `insert into teams_channels (account_id, sealed, host, updated_by) values ($1, $2, $3, $4)
     on conflict (account_id) do update set sealed = excluded.sealed, host = excluded.host, updated_by = excluded.updated_by, updated_at = now()`,
    [input.accountId, input.sealed, input.host, input.updatedBy],
  );
}

export async function deleteTeamsChannel(db: Queryable, accountId: string): Promise<boolean> {
  return (await db.query("delete from teams_channels where account_id = $1 returning account_id", [accountId])).rows.length > 0;
}
