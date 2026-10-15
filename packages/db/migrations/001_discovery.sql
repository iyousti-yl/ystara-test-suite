-- Phase 1b: Datasphere tenants, discovery scans and pipeline definitions.
-- Accounts, users and roles arrive with sign-in; tenants will then belong to an account.
-- Everything stored here is metadata (object definitions and lineage), never table rows.

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  host        text,                      -- Datasphere URL; null for a tenant that only has imported scans
  created_at  timestamptz not null default now()
);

create table scans (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  spaces        text[] not null,
  source        text not null default 'tenant' check (source in ('tenant', 'import')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  object_count  integer,
  edge_count    integer,
  warnings      jsonb not null default '[]',
  error         text
);
create index scans_tenant_requested on scans (tenant_id, requested_at desc);

-- Each distinct definition is stored once per tenant, keyed by its hash, so re-scanning
-- unchanged objects adds no data and "what changed between two scans" is a hash comparison.
create table object_definitions (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  hash        text not null,
  definition  jsonb not null,
  primary key (tenant_id, hash)
);

-- What one scan read. cli_kind and the definition let the graph be rebuilt when the parser improves.
create table scan_objects (
  scan_id          uuid not null references scans (id) on delete cascade,
  space            text not null,
  technical_name   text not null,
  type             text not null,
  cli_kind         text not null,
  business_name    text,
  definition_hash  text not null,
  primary key (scan_id, space, technical_name)
);

-- The lineage graph of one scan. Edges point the way data moves (see packages/shared/src/objects.ts).
create table scan_edges (
  scan_id     uuid not null references scans (id) on delete cascade,
  from_space  text not null,
  from_name   text not null,
  to_space    text not null,
  to_name     text not null,
  kind        text not null check (kind in ('reads_from', 'writes_to', 'triggers')),
  primary key (scan_id, from_space, from_name, to_space, to_name, kind)
);

-- A pipeline is defined by its output object and the writers to leave out. Its steps are
-- computed from the tenant's latest successful scan, so they follow the tenant as it changes.
create table pipelines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id) on delete cascade,
  name             text not null,
  output_space     text not null,
  output_name      text not null,
  exclude_writers  text[] not null default '{}',
  created_at       timestamptz not null default now(),
  unique (tenant_id, name)
);
