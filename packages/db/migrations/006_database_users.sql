-- Phase 2: the database users snapshots read a space's data with (SQL, read access only). Datasphere
-- names them SPACE#SUFFIX and each reads only its own space's schema, so there is one per space.
-- The password is sealed with MASTER_KEY for its tenant and space (v1.<iv>.<tag>.<ciphertext>) and
-- never sent back to a browser. The worker checks a new or changed user (status 'checking'): it signs
-- in, refuses a user that could change the space's schema, and lists what the user sees there:
-- visible is [{ "name": "ORDERS_V", "type": "VIEW" | "TABLE" }], or null until a check got that far.
create table space_database_users (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  space       text not null,
  host        text not null,
  user_name   text not null,
  password    text not null,
  status      text not null default 'checking' check (status in ('checking', 'connected', 'failed')),
  checked_at  timestamptz,
  error       text,
  visible     jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users (id) on delete set null,
  primary key (tenant_id, space)
);
