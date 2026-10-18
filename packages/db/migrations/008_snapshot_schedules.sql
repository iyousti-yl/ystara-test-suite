-- Scheduled snapshots: at most one schedule per pipeline, a cron line read in an IANA time zone
-- (checkSchedule in @ystara/shared). The worker looks every minute for schedules whose next run
-- has come, takes a snapshot of each and moves next_run_at to the run after now, so a worker that
-- was stopped for a while runs a missed schedule once, not once per missed run.
create table pipeline_schedules (
  pipeline_id  uuid primary key references pipelines (id) on delete cascade,
  cron         text not null,
  time_zone    text not null,
  next_run_at  timestamptz not null,
  updated_by   uuid references users (id) on delete set null,
  updated_at   timestamptz not null default now()
);
create index pipeline_schedules_next_run on pipeline_schedules (next_run_at);

-- Whether a snapshot was taken by its pipeline's schedule (requested_by is then null).
alter table snapshots add column scheduled boolean not null default false;
