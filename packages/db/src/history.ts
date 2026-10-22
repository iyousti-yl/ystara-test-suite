import type { HistoryEvent, ScenarioRunStatus, ScenarioSuiteCause, SignOff, SignOffBasis, SignOffVerdict, SnapshotStatus } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * A pipeline's sign-offs (migration 014) and its history: suites, scenario runs
 * on their own, snapshots and sign-offs on one timeline. Read-only here, except
 * adding a sign-off.
 */
export type { HistoryEvent, SignOff, SignOffBasis };

interface SignOffRow {
  id: string;
  pipeline_id: string;
  verdict: SignOffVerdict;
  comment: string;
  signed_email: string;
  signed_at: Date;
  scan_id: string | null;
  scan_finished_at: Date | null;
  suite_id: string | null;
  suite_status: ScenarioRunStatus | null;
  suite_passed: number | null;
  suite_total: number | null;
  suite_finished_at: Date | null;
  snapshot_id: string | null;
  snapshot_finished_at: Date | null;
}

const SELECT_SIGNOFF = `select o.*, sc.finished_at as scan_finished_at,
    su.status as suite_status, su.passed as suite_passed, su.total as suite_total, su.finished_at as suite_finished_at,
    sn.finished_at as snapshot_finished_at
  from pipeline_signoffs o
  left join scans sc on sc.id = o.scan_id
  left join scenario_suites su on su.id = o.suite_id
  left join snapshots sn on sn.id = o.snapshot_id`;

const toSignOff = (r: SignOffRow): SignOff => ({
  id: r.id,
  pipelineId: r.pipeline_id,
  verdict: r.verdict,
  comment: r.comment,
  signedBy: r.signed_email,
  signedAt: r.signed_at,
  scan: r.scan_id ? { id: r.scan_id, finishedAt: r.scan_finished_at } : null,
  suite: r.suite_id && r.suite_status ? { id: r.suite_id, status: r.suite_status, passed: r.suite_passed, total: r.suite_total, finishedAt: r.suite_finished_at } : null,
  snapshot: r.snapshot_id ? { id: r.snapshot_id, finishedAt: r.snapshot_finished_at } : null,
});

/**
 * What a sign-off made now covers: the tenant's latest successful scan, and the
 * pipeline's latest finished suite and latest successful snapshot.
 */
export async function signOffBasis(db: Queryable, pipelineId: string): Promise<SignOffBasis> {
  const { rows } = await db.query<{
    scan_id: string | null;
    scan_finished_at: Date | null;
    suite_id: string | null;
    suite_status: ScenarioRunStatus | null;
    suite_passed: number | null;
    suite_total: number | null;
    suite_finished_at: Date | null;
    snapshot_id: string | null;
    snapshot_finished_at: Date | null;
  }>(
    `select sc.id as scan_id, sc.finished_at as scan_finished_at,
       su.id as suite_id, su.status as suite_status, su.passed as suite_passed, su.total as suite_total, su.finished_at as suite_finished_at,
       sn.id as snapshot_id, sn.finished_at as snapshot_finished_at
     from pipelines p
     left join lateral (select id, finished_at from scans where tenant_id = p.tenant_id and status = 'succeeded' order by finished_at desc limit 1) sc on true
     left join lateral (select * from scenario_suites where pipeline_id = p.id and finished_at is not null order by finished_at desc limit 1) su on true
     left join lateral (select id, finished_at from snapshots where pipeline_id = p.id and status = 'succeeded' order by finished_at desc limit 1) sn on true
     where p.id = $1`,
    [pipelineId],
  );
  const r = rows[0];
  return {
    scan: r?.scan_id ? { id: r.scan_id, finishedAt: r.scan_finished_at } : null,
    suite: r?.suite_id && r.suite_status ? { id: r.suite_id, status: r.suite_status, passed: r.suite_passed, total: r.suite_total, finishedAt: r.suite_finished_at } : null,
    snapshot: r?.snapshot_id ? { id: r.snapshot_id, finishedAt: r.snapshot_finished_at } : null,
  };
}

/** Signs the pipeline off as it stands now (signOffBasis), in one statement so the basis can't move in between. */
export async function createSignOff(
  db: Queryable,
  input: { tenantId: string; pipelineId: string; verdict: SignOffVerdict; comment: string; userId: string },
): Promise<SignOff> {
  const { rows } = await db.query<{ id: string }>(
    `insert into pipeline_signoffs (tenant_id, pipeline_id, verdict, comment, scan_id, suite_id, snapshot_id, signed_by, signed_email)
     select $1, p.id, $3, $4,
       (select id from scans where tenant_id = p.tenant_id and status = 'succeeded' order by finished_at desc limit 1),
       (select id from scenario_suites where pipeline_id = p.id and finished_at is not null order by finished_at desc limit 1),
       (select id from snapshots where pipeline_id = p.id and status = 'succeeded' order by finished_at desc limit 1),
       u.id, u.email
     from pipelines p, users u where p.id = $2 and u.id = $5
     returning id`,
    [input.tenantId, input.pipelineId, input.verdict, input.comment, input.userId],
  );
  return (await getSignOff(db, rows[0].id))!;
}

export async function getSignOff(db: Queryable, id: string): Promise<SignOff | undefined> {
  const { rows } = await db.query<SignOffRow>(`${SELECT_SIGNOFF} where o.id = $1`, [id]);
  return rows[0] && toSignOff(rows[0]);
}

/** A pipeline's sign-offs, newest first. */
export async function listSignOffs(db: Queryable, pipelineId: string, limit = 50): Promise<SignOff[]> {
  const { rows } = await db.query<SignOffRow>(`${SELECT_SIGNOFF} where o.pipeline_id = $1 order by o.signed_at desc limit $2`, [pipelineId, limit]);
  return rows.map(toSignOff);
}

/**
 * A pipeline's history, newest first: its suites, the scenario runs that ran on
 * their own, its snapshots with the output's row count, and its sign-offs.
 * At most `limit` of each kind, then cut to `limit` in all.
 */
export async function pipelineHistory(db: Queryable, pipelineId: string, limit = 100): Promise<HistoryEvent[]> {
  const suites = await db.query<{
    id: string;
    requested_at: Date;
    cause: ScenarioSuiteCause;
    status: ScenarioRunStatus;
    passed: number | null;
    total: number | null;
    changed: number;
  }>(
    `select id, requested_at, cause, status, passed, total, jsonb_array_length(changed) as changed
     from scenario_suites where pipeline_id = $1 order by requested_at desc limit $2`,
    [pipelineId, limit],
  );
  const runs = await db.query<{
    id: string;
    requested_at: Date;
    scenario_id: string;
    scenario_name: string;
    status: ScenarioRunStatus;
    passed: number | null;
    total: number | null;
  }>(
    `select r.id, r.requested_at, r.scenario_id, s.name as scenario_name, r.status, r.passed, r.total
     from scenario_runs r join scenarios s on s.id = r.scenario_id
     where r.pipeline_id = $1 and r.suite_id is null order by r.requested_at desc limit $2`,
    [pipelineId, limit],
  );
  // The output's rows: the pipeline's output as it was saved, measured by the snapshot (its last step).
  const snapshots = await db.query<{ id: string; requested_at: Date; status: SnapshotStatus; scheduled: boolean; output_rows: string | null; alert: boolean }>(
    `select s.id, s.requested_at, s.status, s.scheduled,
       (select o.row_count from snapshot_objects o where o.snapshot_id = s.id and o.space = p.output_space and o.technical_name = p.output_name and o.status = 'measured') as output_rows,
       exists (select 1 from snapshot_alerts a where a.snapshot_id = s.id) as alert
     from snapshots s join pipelines p on p.id = s.pipeline_id
     where s.pipeline_id = $1 order by s.requested_at desc limit $2`,
    [pipelineId, limit],
  );
  const signOffs = await listSignOffs(db, pipelineId, limit);

  const events: HistoryEvent[] = [
    ...suites.rows.map((r): HistoryEvent => ({ kind: "suite", id: r.id, at: r.requested_at, cause: r.cause, status: r.status, passed: r.passed, total: r.total, changed: r.changed })),
    ...runs.rows.map(
      (r): HistoryEvent => ({ kind: "run", id: r.id, at: r.requested_at, scenarioId: r.scenario_id, scenarioName: r.scenario_name, status: r.status, passed: r.passed, total: r.total }),
    ),
    ...snapshots.rows.map(
      (r): HistoryEvent => ({
        kind: "snapshot",
        id: r.id,
        at: r.requested_at,
        status: r.status,
        scheduled: r.scheduled,
        outputRows: r.output_rows === null ? null : Number(r.output_rows),
        alert: r.alert,
      }),
    ),
    ...signOffs.map((s): HistoryEvent => ({ kind: "signoff", id: s.id, at: s.signedAt, verdict: s.verdict, by: s.signedBy, comment: s.comment })),
  ];
  return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
