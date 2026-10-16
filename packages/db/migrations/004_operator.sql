-- Phase 1d, part 2: Ystara's operator (whoever runs the service) and sign-in resets.
-- The operator sees every account and user on the operator panel, never their lineage data.
-- The flag is set with `npm run operator:grant`, never from the web app.
alter table users add column operator boolean not null default false;

-- A one-time link to choose a new password and set up the authenticator app again, made on the
-- operator panel for someone who lost their phone or password. Only the token's hash is stored.
-- Rows stay after use, and after a newer link closes them (expires_at moves to then): who made
-- each link and when it was used is what the user's account admins see on Users and roles.
create table sign_in_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  created_by  uuid references users (id) on delete set null, -- the operator who made it
  token_hash  text not null unique,
  totp_secret text,                     -- sealed with MASTER_KEY; made by the server when the setup is opened
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index sign_in_resets_user on sign_in_resets (user_id);
