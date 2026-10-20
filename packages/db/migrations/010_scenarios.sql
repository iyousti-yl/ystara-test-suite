-- Phase 3b: scenarios, a saved pipeline's test cases made in the app's builder, and their runs.
-- A scenario is the ScenarioSpec of @ystara/shared as JSON: test rows that a person typed in for
-- the pipeline's tables, never rows read from the tenant, and the checks expected at its steps.
create table scenarios (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  pipeline_id uuid not null references pipelines (id) on delete cascade,
  name        text not null,                 -- the same as spec->>'name'
  spec        jsonb not null,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (pipeline_id, name)
);

-- One run of a scenario: the scenario as it was asked for, what stood in for each step, and what
-- each check gave back. Those results come from the scenario's own rows only. steps is
-- [{ "space", "technicalName", "type", "note", "problem" }]; checks is
-- [{ "checkpoint", "label", "status", "detail" }], status pass, fail, error or not_run.
create table scenario_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  scenario_id   uuid not null references scenarios (id) on delete cascade,
  scan_id       uuid references scans (id) on delete set null,   -- the scan whose definitions were compiled
  spec          jsonb not null,
  status        text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'error')),
  requested_by  uuid references users (id) on delete set null,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  steps         jsonb,
  checks        jsonb,
  passed        integer,
  total         integer
);
create index scenario_runs_scenario_requested on scenario_runs (scenario_id, requested_at desc);
