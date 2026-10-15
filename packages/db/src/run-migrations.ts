/**
 * Prepares the database: applies pending migrations and creates the job
 * queues. `npm run db:migrate` on your machine, and the one-shot `migrate`
 * service in docker-compose.yml. Run it before starting the API or worker.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, DEFAULT_DATABASE_URL } from "./db.js";
import { migrate } from "./migrate.js";
import { prepareQueues } from "./queues.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const db = connect(url);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied ${applied.join(", ")}` : "Database is up to date");
} finally {
  await db.close();
}
await prepareQueues(url);
console.log("Job queues ready");
