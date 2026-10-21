-- Phase 3c: secrets of the server itself, which its operator enters on the operator panel. For now
-- one: the Anthropic API key that drafting scenarios with Claude uses (apps/api/src/drafting.ts).
-- Sealed with MASTER_KEY, like tenants' secrets; the API's ANTHROPIC_API_KEY wins when it is set.
create table server_secrets (
  name        text primary key check (name in ('anthropic_api_key')),
  sealed      text not null,
  updated_by  uuid references users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
