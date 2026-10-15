/**
 * Prepares the database: applies pending migrations and creates the job
 * queues. `npm run db:migrate` on your machine, and the one-shot `migrate`
 * service in docker-compose.yml. Run it before starting the API or worker.
 */
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "@ystara/shared/env";
import { connect, databaseUrl } from "./db.js";
import { migrate } from "./migrate.js";
import { prepareQueues } from "./queues.js";

loadLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));

const url = databaseUrl();
const db = connect(url);
try {
  const applied = await migrate(db);
  console.log(`${applied.length ? `Applied ${applied.join(", ")}` : "Up to date"} (${db.where})`);
} finally {
  await db.close();
}
await prepareQueues(url);
console.log("Job queues ready");
