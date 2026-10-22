-- Phase 4: what a design partner's auditors and admins ask for. An audit log of every action,
-- sign-offs of a pipeline's results, and members limited to some spaces.

-- Every action someone took through the API: one row per request that changed something (and
-- each sign-in), written after it succeeded (apps/api/src/audit.ts). action is a key of
-- AUDIT_ACTIONS in @ystara/shared, which says how to show it. target is what it acted on, as the
-- request named it and with its name read before the request ran, so a deleted pipeline keeps
-- its name here: { "kind", "id", "name", "tenantId" }. detail holds only the request fields
-- AUDIT_ACTIONS lists for the action (a name, a role, the spaces), never a secret or a test row.
-- user_email is kept as it was, so the log still reads after the user is gone. account_id is null
-- for what belongs to no account: the operator panel.
create table audit_events (
  id          bigint generated always as identity primary key,
  account_id  uuid references accounts (id) on delete cascade,
  user_id     uuid references users (id) on delete set null,
  user_email  text,
  at          timestamptz not null default now(),
  action      text not null,
  target      jsonb,
  detail      jsonb,
  ip          text
);
create index audit_events_account_at on audit_events (account_id, id desc);

-- A member can be limited to some spaces: null sees every space, a list only those, in every
-- tenant of the account (a space ID such as HR often names the same team's space in DEV and PROD).
-- Admins always see every space. An invitation carries the spaces its member will have.
alter table memberships add column spaces text[];
alter table invitations add column spaces text[];

-- A person who may sign off (results.sign_off) approves or rejects a pipeline as it stood: the
-- scan its steps came from, its latest finished suite and its latest successful snapshot at that
-- moment. A sign-off is outdated once a later scan changes the pipeline's steps.
create table pipeline_signoffs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  pipeline_id  uuid not null references pipelines (id) on delete cascade,
  verdict      text not null check (verdict in ('approved', 'rejected')),
  comment      text not null default '',
  scan_id      uuid references scans (id) on delete set null,
  suite_id     uuid references scenario_suites (id) on delete set null,
  snapshot_id  uuid references snapshots (id) on delete set null,
  signed_by    uuid references users (id) on delete set null,
  signed_email text not null,
  signed_at    timestamptz not null default now()
);
create index pipeline_signoffs_pipeline_signed on pipeline_signoffs (pipeline_id, signed_at desc);
