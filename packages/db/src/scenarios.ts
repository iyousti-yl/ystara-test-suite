import type { ScenarioCheckResult, ScenarioRun, ScenarioRunStatus, ScenarioRunSummary, ScenarioSpec, ScenarioStepNote, StoredScenario } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Scenarios of saved pipelines and their runs (migration 010; the lifecycle
 * is on ScenarioRun in @ystara/shared). The spec is stored as it was checked
 * by ScenarioSpec in @ystara/shared; these queries don't check it again.
 */
export type { ScenarioRun, ScenarioRunSummary, StoredScenario };

/** Thrown when a pipeline already has a scenario of that name. */
export class ScenarioNameTaken extends Error {
  constructor(name: string) {
    super(`This pipeline already has a scenario named "${name}"`);
  }
}

interface ScenarioRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  name: string;
  spec: ScenarioSpec;
  created_at: Date;
  updated_at: Date;
  updated_by_email: string | null;
  run_id: string | null;
  run_status: ScenarioRunStatus | null;
  run_requested_at: Date | null;
  run_finished_at: Date | null;
  run_passed: number | null;
  run_total: number | null;
}

/** A scenario with who saved it last and its latest run. */
const SELECT_SCENARIO = `select s.*, u.email as updated_by_email,
    r.id as run_id, r.status as run_status, r.requested_at as run_requested_at, r.finished_at as run_finished_at,
    r.passed as run_passed, r.total as run_total
  from scenarios s
  left join users u on u.id = s.updated_by
  left join lateral (select * from scenario_runs where scenario_id = s.id order by requested_at desc limit 1) r on true`;

const toScenario = (r: ScenarioRow): StoredScenario => ({
  id: r.id,
  tenantId: r.tenant_id,
  pipelineId: r.pipeline_id,
  name: r.name,
  spec: r.spec,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by_email,
  lastRun: r.run_id
    ? { id: r.run_id, status: r.run_status!, requestedAt: r.run_requested_at!, finishedAt: r.run_finished_at, passed: r.run_passed, total: r.run_total }
    : null,
});

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";

export async function createScenario(db: Queryable, input: { tenantId: string; pipelineId: string; spec: ScenarioSpec; createdBy: string | null }): Promise<StoredScenario> {
  try {
    const { rows } = await db.query<{ id: string }>(
      "insert into scenarios (tenant_id, pipeline_id, name, spec, created_by, updated_by) values ($1, $2, $3, $4::jsonb, $5, $5) returning id",
      [input.tenantId, input.pipelineId, input.spec.name, JSON.stringify(input.spec), input.createdBy],
    );
    return (await getScenario(db, rows[0].id))!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ScenarioNameTaken(input.spec.name);
    throw e;
  }
}

/** Replaces a scenario's spec (and so its name). Undefined when it is gone. */
export async function updateScenario(db: Queryable, id: string, input: { spec: ScenarioSpec; updatedBy: string | null }): Promise<StoredScenario | undefined> {
  try {
    const { rows } = await db.query<{ id: string }>(
      "update scenarios set name = $2, spec = $3::jsonb, updated_by = $4, updated_at = now() where id = $1 returning id",
      [id, input.spec.name, JSON.stringify(input.spec), input.updatedBy],
    );
    return rows[0] && getScenario(db, id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ScenarioNameTaken(input.spec.name);
    throw e;
  }
}

export async function getScenario(db: Queryable, id: string): Promise<StoredScenario | undefined> {
  const { rows } = await db.query<ScenarioRow>(`${SELECT_SCENARIO} where s.id = $1`, [id]);
  return rows[0] && toScenario(rows[0]);
}

/** A pipeline's scenarios, by name. */
export async function listScenarios(db: Queryable, pipelineId: string): Promise<StoredScenario[]> {
  const { rows } = await db.query<ScenarioRow>(`${SELECT_SCENARIO} where s.pipeline_id = $1 order by lower(s.name), s.name`, [pipelineId]);
  return rows.map(toScenario);
}

/** Deletes a scenario and its runs. */
export async function deleteScenario(db: Queryable, id: string): Promise<boolean> {
  return (await db.query("delete from scenarios where id = $1 returning id", [id])).rows.length > 0;
}

interface RunRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  scenario_id: string;
  scan_id: string | null;
  spec: ScenarioSpec;
  status: ScenarioRunStatus;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  steps: ScenarioStepNote[] | null;
  checks: ScenarioCheckResult[] | null;
  passed: number | null;
  total: number | null;
  scenario_name: string;
  pipeline_name: string;
  requested_by_email: string | null;
}

const SELECT_RUN = `select r.*, s.name as scenario_name, p.name as pipeline_name, u.email as requested_by_email
  from scenario_runs r
  join scenarios s on s.id = r.scenario_id
  join pipelines p on p.id = r.pipeline_id
  left join users u on u.id = r.requested_by`;

const toRun = (r: RunRow): ScenarioRun => ({
  id: r.id,
  scenarioId: r.scenario_id,
  scenarioName: r.scenario_name,
  tenantId: r.tenant_id,
  pipelineId: r.pipeline_id,
  pipelineName: r.pipeline_name,
  scanId: r.scan_id,
  spec: r.spec,
  status: r.status,
  requestedAt: r.requested_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
  steps: r.steps,
  checks: r.checks,
  passed: r.passed,
  total: r.total,
  requestedBy: r.requested_by_email,
});

/** A queued run of the scenario as it is now. */
export async function createScenarioRun(db: Queryable, scenario: StoredScenario, requestedBy: string | null): Promise<ScenarioRun> {
  const { rows } = await db.query<{ id: string }>(
    "insert into scenario_runs (tenant_id, pipeline_id, scenario_id, spec, requested_by) values ($1, $2, $3, $4::jsonb, $5) returning id",
    [scenario.tenantId, scenario.pipelineId, scenario.id, JSON.stringify(scenario.spec), requestedBy],
  );
  return (await getScenarioRun(db, rows[0].id))!;
}

export async function getScenarioRun(db: Queryable, id: string): Promise<ScenarioRun | undefined> {
  const { rows } = await db.query<RunRow>(`${SELECT_RUN} where r.id = $1`, [id]);
  return rows[0] && toRun(rows[0]);
}

/** A scenario's runs, newest first, without what each one gave back. */
export async function listScenarioRuns(db: Queryable, scenarioId: string, limit = 50): Promise<ScenarioRunSummary[]> {
  const { rows } = await db.query<RunRow>(
    "select id, status, requested_at, finished_at, passed, total from scenario_runs where scenario_id = $1 order by requested_at desc limit $2",
    [scenarioId, limit],
  );
  return rows.map((r) => ({ id: r.id, status: r.status, requestedAt: r.requested_at, finishedAt: r.finished_at, passed: r.passed, total: r.total }));
}

/** The worker takes a queued run: running, with the scan it compiles. False when it is gone or already taken. */
export async function startScenarioRun(db: Queryable, id: string, scanId: string | null): Promise<boolean> {
  const { rows } = await db.query("update scenario_runs set status = 'running', started_at = now(), scan_id = $2 where id = $1 and status = 'queued' returning id", [
    id,
    scanId,
  ]);
  return rows.length > 0;
}

export async function finishScenarioRun(
  db: Queryable,
  id: string,
  result: { status: "passed" | "failed" | "error"; error?: string; steps?: ScenarioStepNote[]; checks?: ScenarioCheckResult[] },
): Promise<void> {
  const passed = result.checks?.filter((c) => c.status === "pass").length ?? null;
  await db.query(
    "update scenario_runs set status = $2, error = $3, steps = $4::jsonb, checks = $5::jsonb, passed = $6, total = $7, finished_at = now() where id = $1",
    [
      id,
      result.status,
      result.error ?? null,
      result.steps ? JSON.stringify(result.steps) : null,
      result.checks ? JSON.stringify(result.checks) : null,
      passed,
      result.checks?.length ?? null,
    ],
  );
}
