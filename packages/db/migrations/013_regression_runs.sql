-- Phase 3c: scenarios as a regression check, scans on a schedule, and alerts in Microsoft Teams.

-- A suite runs every scenario of a pipeline, one after the other through one sign-in: asked for
-- in the app ('manual'), or queued by the worker after a scan found a changed definition in the
-- pipeline ('scan'). Each scenario's run is a row of scenario_runs with this suite_id, made
-- queued with the suite, so the suite shows what it will run before it starts. changed is
-- [{ "space", "technicalName", "type", "change" }], change "definition", "added" or "removed".
create table scenario_suites (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  cause         text not null check (cause in ('manual', 'scan')),
  scan_id       uuid references scans (id) on delete set null,   -- the scan that queued it
  changed       jsonb not null default '[]',
  status        text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'error')),
  requested_by  uuid references users (id) on delete set null,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  passed        integer,    -- runs that passed
  total         integer     -- runs in the suite
);
create index scenario_suites_pipeline_requested on scenario_suites (pipeline_id, requested_at desc);

alter table scenario_runs add column suite_id uuid references scenario_suites (id) on delete set null;
create index scenario_runs_suite on scenario_runs (suite_id);

-- Scans on a schedule, at most one per tenant, as for snapshots (migration 008). Each run scans
-- the spaces the tenant's technical client could read at its last check. A scheduled scan is
-- marked so, with no one who asked for it.
create table tenant_scan_schedules (
  tenant_id    uuid primary key references tenants (id) on delete cascade,
  cron         text not null,
  time_zone    text not null,
  next_run_at  timestamptz not null,
  updated_by   uuid references users (id) on delete set null,
  updated_at   timestamptz not null default now()
);
create index tenant_scan_schedules_next_run on tenant_scan_schedules (next_run_at);
alter table scans add column scheduled boolean not null default false;

-- An alert when a suite after a scan finds scenarios that passed before and don't now (or ran
-- for the first time and didn't pass). broken is [{ "scenarioId", "runId", "name", "status",
-- "failedChecks": [label] }]: scenario names and check labels, which are the scenario's own
-- test rows, never data read from the tenant.
create table scenario_alerts (
  suite_id      uuid primary key references scenario_suites (id) on delete cascade,
  broken        jsonb not null,
  status        text not null check (status in ('sending', 'sent', 'failed', 'no_watchers', 'no_mail_server')),
  recipients    int not null default 0,
  error         text,
  teams_status  text check (teams_status in ('sending', 'sent', 'failed')),   -- null: the account has no Teams channel
  teams_error   text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
alter table snapshot_alerts add column teams_status text check (teams_status in ('sending', 'sent', 'failed'));
alter table snapshot_alerts add column teams_error text;

-- An account's Microsoft Teams channel: the address of a webhook that posts in it (a Workflows
-- or incoming webhook URL), sealed with MASTER_KEY since anyone who has it can post there. host
-- is kept in the clear to show which service it points at.
create table teams_channels (
  account_id  uuid primary key references accounts (id) on delete cascade,
  sealed      text not null,
  host        text not null,
  updated_by  uuid references users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
