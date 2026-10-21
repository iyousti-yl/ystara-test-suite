import { DEFAULT_ROW_DROP_PERCENT, type PipelineSchedule, type TenantScanSchedule } from "@ystara/shared";
import type { Queryable } from "./db.js";

/** Snapshot schedules (migration 008) and scan schedules (migration 013); checkSchedule and nextRun in @ystara/shared work out the times. */
export type { PipelineSchedule, TenantScanSchedule };

interface Row {
  pipeline_id: string;
  cron: string;
  time_zone: string;
  next_run_at: Date;
  row_drop_percent: number;
  updated_by: string | null;
  updated_at: Date;
}

const toSchedule = (r: Row): PipelineSchedule => ({
  pipelineId: r.pipeline_id,
  cron: r.cron,
  timeZone: r.time_zone,
  nextRunAt: r.next_run_at,
  rowDropPercent: r.row_drop_percent,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export async function getSchedule(db: Queryable, pipelineId: string): Promise<PipelineSchedule | undefined> {
  const { rows } = await db.query<Row>("select * from pipeline_schedules where pipeline_id = $1", [pipelineId]);
  return rows[0] && toSchedule(rows[0]);
}

/** Sets or replaces a pipeline's schedule; `nextRunAt` is its first run. `rowDropPercent`: DEFAULT_ROW_DROP_PERCENT when not given. */
export async function setSchedule(
  db: Queryable,
  input: { pipelineId: string; cron: string; timeZone: string; nextRunAt: Date; rowDropPercent?: number; updatedBy: string | null },
): Promise<PipelineSchedule> {
  const { rows } = await db.query<Row>(
    `insert into pipeline_schedules (pipeline_id, cron, time_zone, next_run_at, row_drop_percent, updated_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (pipeline_id) do update set cron = excluded.cron, time_zone = excluded.time_zone, next_run_at = excluded.next_run_at,
       row_drop_percent = excluded.row_drop_percent, updated_by = excluded.updated_by, updated_at = now()
     returning *`,
    [input.pipelineId, input.cron, input.timeZone, input.nextRunAt, input.rowDropPercent ?? DEFAULT_ROW_DROP_PERCENT, input.updatedBy],
  );
  return toSchedule(rows[0]);
}

export async function deleteSchedule(db: Queryable, pipelineId: string): Promise<boolean> {
  const { rows } = await db.query("delete from pipeline_schedules where pipeline_id = $1 returning pipeline_id", [pipelineId]);
  return rows.length > 0;
}

/**
 * The schedules whose next run has come, earliest first, locked until the
 * transaction ends: a second worker skips them instead of taking them too.
 * Call it inside db.transaction, and move each one's next run on.
 */
export async function lockDueSchedules(tx: Queryable, now: Date, limit = 100): Promise<PipelineSchedule[]> {
  const { rows } = await tx.query<Row>("select * from pipeline_schedules where next_run_at <= $1 order by next_run_at limit $2 for update skip locked", [now, limit]);
  return rows.map(toSchedule);
}

export async function setNextRun(db: Queryable, pipelineId: string, nextRunAt: Date): Promise<void> {
  await db.query("update pipeline_schedules set next_run_at = $2 where pipeline_id = $1", [pipelineId, nextRunAt]);
}

interface ScanScheduleRow {
  tenant_id: string;
  cron: string;
  time_zone: string;
  next_run_at: Date;
  updated_by: string | null;
  updated_at: Date;
}

const toScanSchedule = (r: ScanScheduleRow): TenantScanSchedule => ({
  tenantId: r.tenant_id,
  cron: r.cron,
  timeZone: r.time_zone,
  nextRunAt: r.next_run_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export async function getScanSchedule(db: Queryable, tenantId: string): Promise<TenantScanSchedule | undefined> {
  const { rows } = await db.query<ScanScheduleRow>("select * from tenant_scan_schedules where tenant_id = $1", [tenantId]);
  return rows[0] && toScanSchedule(rows[0]);
}

/** Sets or replaces a tenant's scan schedule; `nextRunAt` is its first run. */
export async function setScanSchedule(
  db: Queryable,
  input: { tenantId: string; cron: string; timeZone: string; nextRunAt: Date; updatedBy: string | null },
): Promise<TenantScanSchedule> {
  const { rows } = await db.query<ScanScheduleRow>(
    `insert into tenant_scan_schedules (tenant_id, cron, time_zone, next_run_at, updated_by) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id) do update set cron = excluded.cron, time_zone = excluded.time_zone, next_run_at = excluded.next_run_at,
       updated_by = excluded.updated_by, updated_at = now()
     returning *`,
    [input.tenantId, input.cron, input.timeZone, input.nextRunAt, input.updatedBy],
  );
  return toScanSchedule(rows[0]);
}

export async function deleteScanSchedule(db: Queryable, tenantId: string): Promise<boolean> {
  const { rows } = await db.query("delete from tenant_scan_schedules where tenant_id = $1 returning tenant_id", [tenantId]);
  return rows.length > 0;
}

/** As lockDueSchedules, for scan schedules. */
export async function lockDueScanSchedules(tx: Queryable, now: Date, limit = 100): Promise<TenantScanSchedule[]> {
  const { rows } = await tx.query<ScanScheduleRow>(
    "select * from tenant_scan_schedules where next_run_at <= $1 order by next_run_at limit $2 for update skip locked",
    [now, limit],
  );
  return rows.map(toScanSchedule);
}

export async function setNextScanRun(db: Queryable, tenantId: string, nextRunAt: Date): Promise<void> {
  await db.query("update tenant_scan_schedules set next_run_at = $2 where tenant_id = $1", [tenantId, nextRunAt]);
}
