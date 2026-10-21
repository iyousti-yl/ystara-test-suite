import type {
  AlertStatus,
  BrokenScenario,
  ChangedStep,
  ScenarioCheckResult,
  ScenarioRunStatus,
  ScenarioSuite,
  ScenarioSuiteCause,
  ScenarioSuiteSummary,
  SuiteRun,
  TeamsDelivery,
} from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Suites: every scenario of a pipeline run one after the other (migration
 * 013; the lifecycle is on ScenarioSuite in @ystara/shared). A suite's runs
 * are rows of scenario_runs made with it, queued, one per scenario.
 */
export type { ScenarioSuite, ScenarioSuiteSummary, SuiteRun };

interface SuiteRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  pipeline_name: string;
  cause: ScenarioSuiteCause;
  scan_id: string | null;
  changed: ChangedStep[];
  status: ScenarioRunStatus;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  passed: number | null;
  total: number | null;
  requested_by_email: string | null;
  alert_broken: BrokenScenario[] | null;
  alert_status: AlertStatus | null;
  alert_recipients: number | null;
  alert_error: string | null;
  alert_sent_at: Date | null;
  alert_teams_status: TeamsDelivery["status"] | null;
  alert_teams_error: string | null;
}

const SELECT_SUITE = `select s.*, p.name as pipeline_name, u.email as requested_by_email,
    a.broken as alert_broken, a.status as alert_status, a.recipients as alert_recipients, a.error as alert_error,
    a.sent_at as alert_sent_at, a.teams_status as alert_teams_status, a.teams_error as alert_teams_error
  from scenario_suites s
  join pipelines p on p.id = s.pipeline_id
  left join users u on u.id = s.requested_by
  left join scenario_alerts a on a.suite_id = s.id`;

const toSummary = (r: Pick<SuiteRow, "id" | "pipeline_id" | "cause" | "status" | "requested_at" | "finished_at" | "passed" | "total">): ScenarioSuiteSummary => ({
  id: r.id,
  pipelineId: r.pipeline_id,
  cause: r.cause,
  status: r.status,
  requestedAt: r.requested_at,
  finishedAt: r.finished_at,
  passed: r.passed,
  total: r.total,
});

/**
 * A queued suite of every scenario the pipeline has now, each with a queued
 * run of the scenario as it is now. One statement, so a scenario saved at the
 * same moment is either in both the count and the runs or in neither.
 */
export async function createScenarioSuite(
  db: Queryable,
  input: { tenantId: string; pipelineId: string; cause: ScenarioSuiteCause; scanId?: string | null; changed?: ChangedStep[]; requestedBy: string | null },
): Promise<ScenarioSuite> {
  const { rows } = await db.query<{ id: string }>(
    `with suite as (
       insert into scenario_suites (tenant_id, pipeline_id, cause, scan_id, changed, requested_by, total)
       values ($1, $2, $3, $4, $5::jsonb, $6, (select count(*)::int from scenarios where pipeline_id = $2))
       returning *
     ), runs as (
       insert into scenario_runs (tenant_id, pipeline_id, scenario_id, spec, requested_by, suite_id, requested_at)
       select sc.tenant_id, sc.pipeline_id, sc.id, sc.spec, suite.requested_by, suite.id, suite.requested_at
         from scenarios sc cross join suite where sc.pipeline_id = suite.pipeline_id
       returning id
     )
     select id from suite`,
    [input.tenantId, input.pipelineId, input.cause, input.scanId ?? null, JSON.stringify(input.changed ?? []), input.requestedBy],
  );
  return (await getScenarioSuite(db, rows[0].id))!;
}

export async function getScenarioSuite(db: Queryable, id: string): Promise<ScenarioSuite | undefined> {
  const { rows } = await db.query<SuiteRow>(`${SELECT_SUITE} where s.id = $1`, [id]);
  const r = rows[0];
  if (!r) return undefined;
  const runs = await db.query<{
    id: string;
    scenario_id: string;
    scenario_name: string;
    status: ScenarioRunStatus;
    requested_at: Date;
    finished_at: Date | null;
    passed: number | null;
    total: number | null;
    error: string | null;
  }>(
    `select r.id, r.scenario_id, sc.name as scenario_name, r.status, r.requested_at, r.finished_at, r.passed, r.total, r.error
       from scenario_runs r join scenarios sc on sc.id = r.scenario_id
      where r.suite_id = $1 order by lower(sc.name), sc.name`,
    [id],
  );
  return {
    ...toSummary(r),
    tenantId: r.tenant_id,
    pipelineName: r.pipeline_name,
    scanId: r.scan_id,
    changed: r.changed,
    startedAt: r.started_at,
    error: r.error,
    requestedBy: r.requested_by_email,
    runs: runs.rows.map((run) => ({
      id: run.id,
      scenarioId: run.scenario_id,
      scenarioName: run.scenario_name,
      status: run.status,
      requestedAt: run.requested_at,
      finishedAt: run.finished_at,
      passed: run.passed,
      total: run.total,
      error: run.error,
    })),
    alert: r.alert_status
      ? {
          broken: r.alert_broken ?? [],
          status: r.alert_status,
          recipients: r.alert_recipients ?? 0,
          error: r.alert_error,
          sentAt: r.alert_sent_at,
          teams: r.alert_teams_status ? { status: r.alert_teams_status, error: r.alert_teams_error } : null,
        }
      : null,
  };
}

/** A pipeline's suites, newest first. */
export async function listScenarioSuites(db: Queryable, pipelineId: string, limit = 20): Promise<ScenarioSuiteSummary[]> {
  const { rows } = await db.query<SuiteRow>("select * from scenario_suites where pipeline_id = $1 order by requested_at desc limit $2", [pipelineId, limit]);
  return rows.map(toSummary);
}

/** The worker takes a queued suite. False when it is gone or already taken. */
export async function startScenarioSuite(db: Queryable, id: string): Promise<boolean> {
  const { rows } = await db.query("update scenario_suites set status = 'running', started_at = now() where id = $1 and status = 'queued' returning id", [id]);
  return rows.length > 0;
}

/** The suite's runs, in the order they run: by scenario name. */
export async function suiteRunIds(db: Queryable, suiteId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "select r.id from scenario_runs r join scenarios sc on sc.id = r.scenario_id where r.suite_id = $1 order by lower(sc.name), sc.name",
    [suiteId],
  );
  return rows.map((r) => r.id);
}

/**
 * Finishes a suite from its runs: passed when each one passed, failed
 * otherwise. `error`: why it couldn't start, which makes it an error and
 * marks its runs that are still queued as errors too.
 */
export async function finishScenarioSuite(db: Queryable, id: string, error?: string): Promise<void> {
  if (error) {
    await db.query("update scenario_runs set status = 'error', error = $2, finished_at = now() where suite_id = $1 and status = 'queued'", [id, error]);
  }
  await db.query(
    `update scenario_suites s set
       passed = c.passed, total = c.total, finished_at = now(), error = $2,
       status = case when $2::text is not null then 'error' when c.total > 0 and c.passed = c.total then 'passed' else 'failed' end
     from (select count(*) filter (where status = 'passed')::int as passed, count(*)::int as total from scenario_runs where suite_id = $1) c
     where s.id = $1`,
    [id, error ?? null],
  );
}

/** Whether a suite of the pipeline asked for after `since` is still queued or running. */
export async function hasUnfinishedSuite(db: Queryable, pipelineId: string, since: Date): Promise<boolean> {
  const { rows } = await db.query("select 1 from scenario_suites where pipeline_id = $1 and status in ('queued', 'running') and requested_at > $2 limit 1", [pipelineId, since]);
  return rows.length > 0;
}

/** The scan the pipeline's scenarios last ran on (its latest finished run that compiled one), if any. */
export async function lastScenarioScanId(db: Queryable, pipelineId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ scan_id: string }>(
    "select scan_id from scenario_runs where pipeline_id = $1 and scan_id is not null and status in ('passed', 'failed', 'error') order by finished_at desc nulls last limit 1",
    [pipelineId],
  );
  return rows[0]?.scan_id;
}

/** The suite's runs with what their checks gave back, for its alert. */
export async function suiteRunResults(
  db: Queryable,
  suiteId: string,
): Promise<{ id: string; scenarioId: string; scenarioName: string; status: ScenarioRunStatus; checks: ScenarioCheckResult[] | null }[]> {
  const { rows } = await db.query<{ id: string; scenario_id: string; scenario_name: string; status: ScenarioRunStatus; checks: ScenarioCheckResult[] | null }>(
    `select r.id, r.scenario_id, sc.name as scenario_name, r.status, r.checks
       from scenario_runs r join scenarios sc on sc.id = r.scenario_id
      where r.suite_id = $1 order by lower(sc.name), sc.name`,
    [suiteId],
  );
  return rows.map((r) => ({ id: r.id, scenarioId: r.scenario_id, scenarioName: r.scenario_name, status: r.status, checks: r.checks }));
}

/** For each scenario in the suite, the status of its latest finished run asked for before the suite, by scenario id. */
export async function statusesBeforeSuite(db: Queryable, suiteId: string): Promise<Map<string, ScenarioRunStatus>> {
  const { rows } = await db.query<{ scenario_id: string; status: ScenarioRunStatus }>(
    `select r.scenario_id, prev.status
       from scenario_runs r
       join lateral (
         select p.status from scenario_runs p
          where p.scenario_id = r.scenario_id and p.suite_id is distinct from r.suite_id
            and p.status in ('passed', 'failed', 'error') and p.requested_at < r.requested_at
          order by p.requested_at desc limit 1
       ) prev on true
      where r.suite_id = $1`,
    [suiteId],
  );
  return new Map(rows.map((r) => [r.scenario_id, r.status]));
}
