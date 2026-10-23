-- Production readiness: indexes for the queries that run most, sessions that end when unused,
-- drafting with Claude switched on per account, and a sign of life from the workers.

-- The history, the board and the check after every scan read scenario runs by pipeline; deleting a
-- tenant, a pipeline or a scan cascades (or sets null) through these columns, which reads the whole
-- table for each deleted row without an index.
create index scenario_runs_pipeline_requested on scenario_runs (pipeline_id, requested_at desc);
create index scenario_runs_scan on scenario_runs (scan_id);
create index scenario_runs_tenant on scenario_runs (tenant_id);
create index scenarios_pipeline on scenarios (pipeline_id);
create index scenarios_tenant on scenarios (tenant_id);
create index scenario_suites_scan on scenario_suites (scan_id);
create index scenario_suites_tenant on scenario_suites (tenant_id);
create index snapshots_scan on snapshots (scan_id);
create index snapshots_tenant on snapshots (tenant_id);
create index snapshot_alerts_compared_with on snapshot_alerts (compared_with);
create index pipeline_signoffs_scan on pipeline_signoffs (scan_id);
create index pipeline_signoffs_tenant on pipeline_signoffs (tenant_id);
create index pipelines_tenant on pipelines (tenant_id);
create index audit_events_user on audit_events (user_id);
-- "The latest successful scan of a tenant" and "the latest successful snapshot of a pipeline".
create index scans_tenant_succeeded on scans (tenant_id, finished_at desc) where status = 'succeeded';
create index snapshots_pipeline_succeeded on snapshots (pipeline_id, finished_at desc) where status = 'succeeded';

-- A session also ends after an hour without use (apps/api/src/auth/access.ts): the last time
-- someone used it, moved at most once a minute.
alter table sessions add column last_seen_at timestamptz not null default now();

-- Drafting with Claude sends a pipeline's definitions to Anthropic: each account's admin decides,
-- and it is off until they switch it on (the operator's key alone no longer turns it on).
alter table accounts add column drafting_with_claude boolean not null default false;

-- The worker that takes the once-a-minute schedule tick says so here. /api/health answers 503 when
-- no worker did for 3 minutes, so the uptime check that watches the API also sees a stopped worker.
create table worker_heartbeats (
  worker      text primary key,   -- host name and process id
  version     text not null,
  started_at  timestamptz not null,
  seen_at     timestamptz not null
);

-- A known value sealed with MASTER_KEY at the first start: every later start checks it opens, so a
-- wrong key stops the API and the worker at once (assertMasterKey in packages/db).
alter table server_secrets drop constraint server_secrets_name_check;
alter table server_secrets add constraint server_secrets_name_check check (name in ('anthropic_api_key', 'master_key_check'));
