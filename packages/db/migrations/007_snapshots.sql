-- Phase 2: snapshots, the measures of a pipeline's steps at one moment, taken with SQL through each
-- space's database user. Never rows: per object its row count, and per column counts, min and max as
-- salted hashes made in the tenant's database, and a sum (hashed on objects with fewer than 10 rows).

-- The salt mixed into every hash of one tenant, sealed with MASTER_KEY. Made once and never changed:
-- with another salt, every hash would differ and every comparison would show a change.
create table tenant_snapshot_salts (
  tenant_id  uuid primary key references tenants (id) on delete cascade,
  salt       text not null,
  created_at timestamptz not null default now()
);

create table snapshots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  scan_id       uuid references scans (id) on delete set null,   -- the scan whose steps were measured
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  requested_by  uuid references users (id) on delete set null,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text
);
create index snapshots_pipeline_requested on snapshots (pipeline_id, requested_at desc);

-- Every step of the pipeline: measured, not measurable (reason: why, as on the pipeline page), or
-- failed (reason: the error). columns is [{ "name", "dataType", "nonNull", "distinct", "minHash",
-- "maxHash", "sum", "sumHash" }], each measure only for the types that have it.
create table snapshot_objects (
  snapshot_id     uuid not null references snapshots (id) on delete cascade,
  position        integer not null,                -- pipeline order, upstream first
  space           text not null,
  technical_name  text not null,
  type            text not null,
  definition_hash text,
  status          text not null check (status in ('measured', 'not_measurable', 'failed')),
  reason          text,
  row_count       bigint,
  columns         jsonb,
  took_ms         integer,
  primary key (snapshot_id, space, technical_name)
);
