import PgBoss from "pg-boss";
import {
  CONNECTION_CHECK_QUEUE_OPTIONS,
  DATABASE_CHECK_QUEUE_OPTIONS,
  JOBS,
  SCAN_QUEUE_OPTIONS,
  SCENARIO_ALERT_QUEUE_OPTIONS,
  SCENARIO_RUN_QUEUE_OPTIONS,
  SCENARIO_SUITE_QUEUE_OPTIONS,
  SCHEDULE_TICK_QUEUE_OPTIONS,
  SNAPSHOT_ALERT_QUEUE_OPTIONS,
  SNAPSHOT_QUEUE_OPTIONS,
} from "@ystara/shared";

const QUEUES: [string, object][] = [
  [JOBS.scan, SCAN_QUEUE_OPTIONS],
  [JOBS.connectionCheck, CONNECTION_CHECK_QUEUE_OPTIONS],
  [JOBS.databaseCheck, DATABASE_CHECK_QUEUE_OPTIONS],
  [JOBS.snapshot, SNAPSHOT_QUEUE_OPTIONS],
  [JOBS.scheduleTick, SCHEDULE_TICK_QUEUE_OPTIONS],
  [JOBS.snapshotAlert, SNAPSHOT_ALERT_QUEUE_OPTIONS],
  [JOBS.scenarioRun, SCENARIO_RUN_QUEUE_OPTIONS],
  [JOBS.scenarioSuite, SCENARIO_SUITE_QUEUE_OPTIONS],
  [JOBS.scenarioAlert, SCENARIO_ALERT_QUEUE_OPTIONS],
];

/**
 * Creates pg-boss's own tables and our job queues. Runs with the migrations,
 * before the API and worker start: if both created the queue at the same
 * moment, Postgres could deadlock. A queue that exists already gets the
 * settings in @ystara/shared again (createQueue alone leaves an existing queue
 * as it was), so a changed time limit reaches a running server with the next
 * deploy.
 */
export async function prepareQueues(connectionString: string): Promise<void> {
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
  await boss.start();
  for (const [name, options] of QUEUES) {
    await boss.createQueue(name, { name, ...options });
    await boss.updateQueue(name, { name, ...options });
  }
  await boss.stop({ graceful: false, wait: true });
}
