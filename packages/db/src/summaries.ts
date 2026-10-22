import type { AlertReason, PipelineSummary, ScenarioRunStatus, ScenarioSuiteCause, SignOffVerdict, SnapshotStatus } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * What the Pipelines board shows for each of a tenant's pipelines (pipelineHealth
 * in @ystara/shared reads it): its latest run of all scenarios, its latest
 * snapshot with the output's rows and its alert, its schedule, its latest
 * sign-off and whether `userId` watches it. One query for the whole tenant.
 */
export type { PipelineSummary };

/** A summary as stored: the sign-off with the scan it covered, which the API compares with the latest scan to say whether it is outdated. */
export type StoredPipelineSummary = Omit<PipelineSummary, "signOff"> & {
  signOff: (Omit<NonNullable<PipelineSummary["signOff"]>, "outdated"> & { scanId: string | null }) | null;
};

interface Row {
  pipeline_id: string;
  scenarios: number;
  suite_id: string | null;
  suite_cause: ScenarioSuiteCause | null;
  suite_status: ScenarioRunStatus | null;
  suite_requested_at: Date | null;
  suite_finished_at: Date | null;
  suite_passed: number | null;
  suite_total: number | null;
  snapshot_id: string | null;
  snapshot_status: SnapshotStatus | null;
  snapshot_scheduled: boolean | null;
  snapshot_requested_at: Date | null;
  snapshot_finished_at: Date | null;
  output_rows: string | null;
  alert: AlertReason[] | null;
  cron: string | null;
  time_zone: string | null;
  next_run_at: Date | null;
  verdict: SignOffVerdict | null;
  signed_at: Date | null;
  signed_scan_id: string | null;
  watching: boolean;
}

export async function pipelineSummaries(db: Queryable, tenantId: string, userId: string): Promise<StoredPipelineSummary[]> {
  const { rows } = await db.query<Row>(
    `select p.id as pipeline_id,
        (select count(*)::int from scenarios c where c.pipeline_id = p.id) as scenarios,
        su.id as suite_id, su.cause as suite_cause, su.status as suite_status, su.requested_at as suite_requested_at,
        su.finished_at as suite_finished_at, su.passed as suite_passed, su.total as suite_total,
        sn.id as snapshot_id, sn.status as snapshot_status, sn.scheduled as snapshot_scheduled,
        sn.requested_at as snapshot_requested_at, sn.finished_at as snapshot_finished_at,
        (select o.row_count::text from snapshot_objects o
          where o.snapshot_id = sn.id and o.space = p.output_space and o.technical_name = p.output_name) as output_rows,
        (select a.reasons from snapshot_alerts a where a.snapshot_id = sn.id) as alert,
        sc.cron, sc.time_zone, sc.next_run_at,
        so.verdict, so.signed_at, so.scan_id as signed_scan_id,
        exists (select 1 from pipeline_watchers w where w.pipeline_id = p.id and w.user_id = $2) as watching
      from pipelines p
      left join lateral (select * from scenario_suites s where s.pipeline_id = p.id order by s.requested_at desc limit 1) su on true
      left join lateral (select * from snapshots s where s.pipeline_id = p.id order by s.requested_at desc limit 1) sn on true
      left join pipeline_schedules sc on sc.pipeline_id = p.id
      left join lateral (select * from pipeline_signoffs o where o.pipeline_id = p.id order by o.signed_at desc limit 1) so on true
      where p.tenant_id = $1
      order by p.name`,
    [tenantId, userId],
  );
  return rows.map((r) => ({
    pipelineId: r.pipeline_id,
    scenarios: r.scenarios,
    suite:
      r.suite_id && r.suite_cause && r.suite_status && r.suite_requested_at
        ? { id: r.suite_id, cause: r.suite_cause, status: r.suite_status, requestedAt: r.suite_requested_at, finishedAt: r.suite_finished_at, passed: r.suite_passed, total: r.suite_total }
        : null,
    snapshot:
      r.snapshot_id && r.snapshot_status && r.snapshot_requested_at
        ? {
            id: r.snapshot_id,
            status: r.snapshot_status,
            scheduled: r.snapshot_scheduled ?? false,
            requestedAt: r.snapshot_requested_at,
            finishedAt: r.snapshot_finished_at,
            outputRows: r.output_rows === null ? null : Number(r.output_rows),
            alert: r.alert,
          }
        : null,
    schedule: r.cron && r.time_zone && r.next_run_at ? { cron: r.cron, timeZone: r.time_zone, nextRunAt: r.next_run_at } : null,
    signOff: r.verdict && r.signed_at ? { verdict: r.verdict, signedAt: r.signed_at, scanId: r.signed_scan_id } : null,
    watching: r.watching,
  }));
}
