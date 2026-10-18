-- Alerts on scheduled snapshots (alerts.ts in @ystara/shared). People watch a pipeline to get
-- them by email; whoever saves a pipeline watches it. Mail goes only to watchers who are still
-- members of the pipeline's account, which is checked when it is sent.
create table pipeline_watchers (
  pipeline_id  uuid not null references pipelines (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (pipeline_id, user_id)
);

-- An alert when the output loses more than this share of its rows from one scheduled snapshot to the next.
alter table pipeline_schedules add column row_drop_percent smallint not null default 20 check (row_drop_percent between 1 and 100);

-- One row per scheduled snapshot that called for an alert: why (step and column names and row
-- counts, never values), which snapshot it was compared with, and whether the email went out.
create table snapshot_alerts (
  snapshot_id    uuid primary key references snapshots (id) on delete cascade,
  compared_with  uuid references snapshots (id) on delete set null,
  reasons        jsonb not null,
  status         text not null check (status in ('sending', 'sent', 'failed', 'no_watchers', 'no_mail_server')),
  recipients     int not null default 0,
  error          text,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz
);
