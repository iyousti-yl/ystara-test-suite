import PgBoss from "pg-boss";
import { JOBS, SCAN_QUEUE_OPTIONS } from "@ystara/shared";

/**
 * Creates pg-boss's own tables and our job queues. Runs with the migrations,
 * before the API and worker start: if both created the queue at the same
 * moment, Postgres could deadlock.
 */
export async function prepareQueues(connectionString: string): Promise<void> {
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
  await boss.start();
  await boss.createQueue(JOBS.scan, { name: JOBS.scan, ...SCAN_QUEUE_OPTIONS });
  await boss.stop({ graceful: false, wait: true });
}
