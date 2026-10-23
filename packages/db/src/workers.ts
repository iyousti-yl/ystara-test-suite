import type { Queryable } from "./db.js";

/**
 * A sign of life from the workers (migration 015). The worker that takes the
 * once-a-minute schedule tick records it, so a fresh row means jobs are being
 * taken, not only that a process exists. /api/health reads the newest one.
 */
export async function recordHeartbeat(db: Queryable, input: { worker: string; version: string; startedAt: Date }): Promise<void> {
  await db.query(
    `insert into worker_heartbeats (worker, version, started_at, seen_at) values ($1, $2, $3, now())
     on conflict (worker) do update set version = excluded.version, seen_at = now()`,
    [input.worker, input.version, input.startedAt],
  );
  // Workers that stopped a day ago are no longer worth showing.
  await db.query("delete from worker_heartbeats where seen_at < now() - interval '1 day'");
}

/** When a worker last took the tick, or undefined when none ever did (or not for a day). */
export async function lastHeartbeat(db: Queryable): Promise<{ seenAt: Date; version: string } | undefined> {
  const { rows } = await db.query<{ seen_at: Date; version: string }>("select seen_at, version from worker_heartbeats order by seen_at desc limit 1");
  return rows[0] && { seenAt: rows[0].seen_at, version: rows[0].version };
}
