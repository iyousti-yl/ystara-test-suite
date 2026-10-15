import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import PgBoss from "pg-boss";
import { ZodError } from "zod";
import { connect, DEFAULT_DATABASE_URL, type Db } from "@ystara/db";
import { ROLES } from "@ystara/shared";
import { discoveryRoutes } from "./routes/discovery.js";

/**
 * API entry point. Routes arrive per phase:
 *   phase 1: tenants, scans, lineage, pipelines (routes/discovery.ts)
 *   later:   sign-in, accounts and roles; snapshots, runs, alerts; scenarios
 *
 * There is no sign-in yet, so the API listens on 127.0.0.1 only (inside
 * Docker it listens on all interfaces, and docker-compose.yml publishes it on
 * 127.0.0.1 only). Never expose it before sign-in exists.
 */

/** Where background jobs go: pg-boss in the running app, a list in tests. */
export interface JobQueue {
  send(name: string, data: object): Promise<unknown>;
}

export async function buildServer(deps: { db: Db; queue: JobQueue }, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" });

  app.setErrorHandler((err: FastifyError | ZodError, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err.code === "23505") return reply.code(409).send({ error: "That name is already taken" }); // unique_violation
    reply.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : "Internal error" });
  });

  app.get("/health", async () => ({ status: "ok", service: "ystara-api", time: new Date().toISOString() }));
  app.get("/meta", async () => ({ roles: ROLES, version: process.env.npm_package_version ?? "dev" }));
  await app.register(discoveryRoutes(deps.db, deps.queue));

  return app;
}

// pathToFileURL keeps this check working on Windows (C:\... vs file:///C:/...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const boss = new PgBoss(url);
  boss.on("error", (err) => console.error("[api] queue error", err));
  await boss.start(); // queues are created by `npm run db:migrate`

  const app = await buildServer({ db: connect(url), queue: boss });
  await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: process.env.API_HOST ?? "127.0.0.1" });
}
