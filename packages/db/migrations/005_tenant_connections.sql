-- Phase 1e: how the worker logs in to a tenant. One technical OAuth client per tenant (purpose
-- "Technical User" in Datasphere), so scans run with nobody present. The secret is sealed with
-- MASTER_KEY (v1.<iv>.<tag>.<ciphertext>) and never sent back to a browser.
-- The admin names the spaces to scan; the worker checks a new or changed client or space list
-- (status 'checking') by listing a little of each space, and stores per space whether it could:
-- spaces is [{ "space": "SALES", "readable": true | false | null (not checked yet), "error": text | null }].
create table tenant_connections (
  tenant_id      uuid primary key references tenants (id) on delete cascade,
  client_id      text not null,
  client_secret  text not null,
  token_url      text not null,
  status         text not null default 'checking' check (status in ('checking', 'connected', 'failed')),
  checked_at     timestamptz,
  error          text,
  spaces         jsonb not null default '[]',
  updated_at     timestamptz not null default now(),
  updated_by     uuid references users (id) on delete set null
);
