import type { AlertReason, AlertStatus, ColumnMeasures, Snapshot, SnapshotDetails, SnapshotObject, SnapshotStatus, TeamsDelivery } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Snapshots of pipelines (migration 007; the lifecycle and the GDPR rules are
 * on Snapshot in @ystara/shared) and each tenant's snapshot salt. The salt
 * arrives here sealed with MASTER_KEY, as the other secrets do.
 */
export type { Snapshot, SnapshotDetails, SnapshotObject, SnapshotStatus };

interface Row {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  scan_id: string | null;
  status: SnapshotStatus;
  scheduled: boolean;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  pipeline_name: string;
  measured: number;
  not_measurable: number;
  failed: number;
  alert_reasons: AlertReason[] | null;
  alert_compared_with: string | null;
  alert_status: AlertStatus | null;
  alert_recipients: number | null;
  alert_error: string | null;
  alert_sent_at: Date | null;
  alert_teams_status: TeamsDelivery["status"] | null;
  alert_teams_error: string | null;
}

/** A snapshot with how many of its steps were measured, couldn't be, and failed, and its alert (migration 009). */
const SELECT = `select s.*, p.name as pipeline_name,
    (select count(*)::int from snapshot_objects o where o.snapshot_id = s.id and o.status = 'measured') as measured,
    (select count(*)::int from snapshot_objects o where o.snapshot_id = s.id and o.status = 'not_measurable') as not_measurable,
    (select count(*)::int from snapshot_objects o where o.snapshot_id = s.id and o.status = 'failed') as failed,
    a.reasons as alert_reasons, a.compared_with as alert_compared_with, a.status as alert_status,
    a.recipients as alert_recipients, a.error as alert_error, a.sent_at as alert_sent_at,
    a.teams_status as alert_teams_status, a.teams_error as alert_teams_error
  from snapshots s join pipelines p on p.id = s.pipeline_id left join snapshot_alerts a on a.snapshot_id = s.id`;

const toSnapshot = (r: Row): Snapshot => ({
  id: r.id,
  tenantId: r.tenant_id,
  pipelineId: r.pipeline_id,
  pipelineName: r.pipeline_name,
  scanId: r.scan_id,
  status: r.status,
  scheduled: r.scheduled,
  requestedAt: r.requested_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
  counts: { measured: r.measured, notMeasurable: r.not_measurable, failed: r.failed },
  alert: r.alert_status
    ? {
        reasons: r.alert_reasons ?? [],
        comparedWith: r.alert_compared_with,
        status: r.alert_status,
        recipients: r.alert_recipients ?? 0,
        error: r.alert_error,
        sentAt: r.alert_sent_at,
        teams: r.alert_teams_status ? { status: r.alert_teams_status, error: r.alert_teams_error } : null,
      }
    : null,
});

/**
 * A queued snapshot, asked for by a person (`requestedBy`) or by the pipeline's schedule (`scheduled`).
 * `requestedAt`: the schedule tick's own clock, so a tick and the snapshots it queued agree on the time. Otherwise the database's.
 */
export async function createSnapshot(
  db: Queryable,
  input: { tenantId: string; pipelineId: string; requestedBy: string | null; scheduled?: boolean; requestedAt?: Date },
): Promise<Snapshot> {
  const { rows } = await db.query<{ id: string }>(
    "insert into snapshots (tenant_id, pipeline_id, requested_by, scheduled, requested_at) values ($1, $2, $3, $4, coalesce($5, now())) returning id",
    [input.tenantId, input.pipelineId, input.requestedBy, input.scheduled ?? false, input.requestedAt ?? null],
  );
  return (await getSnapshot(db, rows[0].id))!;
}

export async function getSnapshot(db: Queryable, id: string): Promise<Snapshot | undefined> {
  const { rows } = await db.query<Row>(`${SELECT} where s.id = $1`, [id]);
  return rows[0] && toSnapshot(rows[0]);
}

/** A pipeline's snapshots, newest first. */
/** Newest first, `limit` at a time; `before` (the requestedAt of the oldest one shown) gives the next older ones. */
export async function listSnapshots(db: Queryable, pipelineId: string, page: { before?: Date; limit?: number } = {}): Promise<Snapshot[]> {
  const { rows } = await db.query<Row>(
    `${SELECT} where s.pipeline_id = $1 and ($3::timestamptz is null or s.requested_at < $3) order by s.requested_at desc limit $2`,
    [pipelineId, page.limit ?? 50, page.before ?? null],
  );
  return rows.map(toSnapshot);
}

interface ObjectRow {
  space: string;
  technical_name: string;
  type: SnapshotObject["type"];
  definition_hash: string | null;
  status: SnapshotObject["status"];
  reason: string | null;
  row_count: string | null;
  columns: ColumnMeasures[] | null;
  took_ms: number | null;
}

/** A snapshot with every step in pipeline order. */
export async function getSnapshotDetails(db: Queryable, id: string): Promise<SnapshotDetails | undefined> {
  const snapshot = await getSnapshot(db, id);
  if (!snapshot) return undefined;
  const { rows } = await db.query<ObjectRow>("select * from snapshot_objects where snapshot_id = $1 order by position", [id]);
  const objects = rows.map(
    (r): SnapshotObject => ({
      space: r.space,
      technicalName: r.technical_name,
      type: r.type,
      definitionHash: r.definition_hash,
      status: r.status,
      reason: r.reason,
      rows: r.row_count === null ? null : Number(r.row_count),
      columns: r.columns,
      tookMs: r.took_ms,
    }),
  );
  return { ...snapshot, objects };
}

/** Whether a snapshot of the pipeline asked for since `since` is still queued or running. Older ones are taken as stuck. */
export async function hasUnfinishedSnapshot(db: Queryable, pipelineId: string, since: Date): Promise<boolean> {
  const { rows } = await db.query("select 1 from snapshots where pipeline_id = $1 and status in ('queued', 'running') and requested_at > $2 limit 1", [pipelineId, since]);
  return rows.length > 0;
}

/** The worker takes a queued snapshot: running, with the scan whose steps it measures. False when it is gone or already taken. */
export async function startSnapshot(db: Queryable, id: string, scanId: string | null): Promise<boolean> {
  const { rows } = await db.query("update snapshots set status = 'running', started_at = now(), scan_id = $2 where id = $1 and status = 'queued' returning id", [
    id,
    scanId,
  ]);
  return rows.length > 0;
}

/** One step's result, in pipeline order. */
export async function saveSnapshotObject(db: Queryable, snapshotId: string, position: number, o: SnapshotObject): Promise<void> {
  await db.query(
    `insert into snapshot_objects (snapshot_id, position, space, technical_name, type, definition_hash, status, reason, row_count, columns, took_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [snapshotId, position, o.space, o.technicalName, o.type, o.definitionHash, o.status, o.reason, o.rows, o.columns && JSON.stringify(o.columns), o.tookMs],
  );
}

export async function finishSnapshot(db: Queryable, id: string, result: { status: "succeeded" | "failed"; error?: string }): Promise<void> {
  await db.query("update snapshots set status = $2, error = $3, finished_at = now() where id = $1", [id, result.status, result.error ?? null]);
}

/**
 * The tenant's sealed snapshot salt. Made once (`seal` is called only when
 * there is none yet) and never replaced: two workers that race both read back
 * the one that was stored first.
 */
export async function snapshotSalt(db: Queryable, tenantId: string, seal: () => string): Promise<string> {
  const read = async () => (await db.query<{ salt: string }>("select salt from tenant_snapshot_salts where tenant_id = $1", [tenantId])).rows[0]?.salt;
  const existing = await read();
  if (existing) return existing;
  await db.query("insert into tenant_snapshot_salts (tenant_id, salt) values ($1, $2) on conflict (tenant_id) do nothing", [tenantId, seal()]);
  return (await read())!;
}
