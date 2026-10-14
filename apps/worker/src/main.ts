/**
 * Worker entry point. Consumes jobs from Postgres (pg-boss) so we need no
 * separate queue service. Job types arrive per phase:
 *   scan.space        (phase 1) discovery of a space into a lineage graph
 *   snapshot.capture  (phase 2) metrics of pipeline objects
 *   snapshot.compare  (phase 2)
 *   scenario.run      (phase 3) fixtures -> test copies -> flows -> assertions
 *
 * Phase 0 only starts the queue and registers a no-op job so the deployment can be verified.
 */
import PgBoss from "pg-boss";

const boss = new PgBoss(process.env.DATABASE_URL ?? "postgres://ystara:ystara@localhost:5432/ystara");

boss.on("error", (err) => console.error("[worker] queue error", err));

await boss.start();
await boss.createQueue("ping");
await boss.work("ping", async (jobs) => {
  for (const job of jobs) console.log("[worker] ping", job.id);
});
console.log("[worker] started");
