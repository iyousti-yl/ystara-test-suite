-- Phase 1e: how the worker logs in to a tenant. One technical OAuth client per tenant (purpose
-- "Technical User" in Datasphere), so scans run with nobody present. The secret is sealed with
-- MASTER_KEY (v1.<iv>.<tag>.<ciphertext>) and never sent back to a browser.
-- The worker checks a new or changed client (status 'checking') and stores the spaces it can see.
create table tenant_connections (
  tenant_id      uuid primary key references tenants (id) on delete cascade,
  client_id      text not null,
  client_secret  text not null,
  token_url      text not null,
  status         text not null default 'checking' check (status in ('checking', 'connected', 'failed')),
  checked_at     timestamptz,
  error          text,
  spaces         text[] not null default '{}',
  updated_at     timestamptz not null default now(),
  updated_by     uuid references users (id) on delete set null
);
