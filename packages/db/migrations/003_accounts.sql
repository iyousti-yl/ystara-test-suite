-- Phase 1d: customer accounts, their users and roles, sign-in sessions and invitations.
-- A user can belong to several accounts (a consultant working for several customers),
-- with one role in each. Roles and permissions are defined in packages/shared/src/roles.ts.

create table accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique check (email = lower(email)),
  password_hash    text not null,          -- scrypt, see apps/api/src/auth/passwords.ts
  totp_secret      text not null,          -- encrypted with MASTER_KEY, see apps/api/src/auth/secrets.ts
  totp_last_step   bigint not null default 0, -- last code used, so a code works only once
  failed_codes     int not null default 0,  -- wrong authenticator codes in a row, across sessions
  codes_locked_until timestamptz,           -- after too many, no code is checked until then
  created_at       timestamptz not null default now()
);

create table memberships (
  account_id  uuid not null references accounts (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  role        text not null check (role in ('admin', 'developer', 'test_coordinator', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (account_id, user_id)
);
create index memberships_user on memberships (user_id);

-- A link to join an account with a role. Only the token's hash is stored: the link is shown once.
-- A new user's authenticator secret is made by the server and kept here (sealed) until they accept.
create table invitations (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts (id) on delete cascade,
  email        text not null check (email = lower(email)),
  role         text not null check (role in ('admin', 'developer', 'test_coordinator', 'viewer')),
  token_hash   text not null unique,
  totp_secret  text,                       -- sealed with MASTER_KEY; set when the new user opens the setup
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz
);
create index invitations_account on invitations (account_id);

-- Signed-in browsers. The cookie holds a random token; only its hash is stored here.
-- A session is "verified" once the second factor (the authenticator code) has been checked.
create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users (id) on delete cascade,
  account_id  uuid not null references accounts (id) on delete cascade,
  verified    boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user on sessions (user_id);

-- Tenants belong to an account now. Tenants from before sign-in go to an account named "Default";
-- `npm run account:create -- --name Default --admin <email>` invites its first admin.
-- An account with tenants can't be deleted by accident: its tenants (and their scans) go first, on purpose.
alter table tenants add column account_id uuid references accounts (id) on delete restrict;
insert into accounts (name) select 'Default' where exists (select 1 from tenants);
update tenants set account_id = (select id from accounts where name = 'Default') where account_id is null;
alter table tenants alter column account_id set not null;
alter table tenants drop constraint tenants_name_key;
alter table tenants add constraint tenants_account_name unique (account_id, name);
