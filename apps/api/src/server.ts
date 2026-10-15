import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import PgBoss from "pg-boss";
import { ZodError } from "zod";
import { assertYstaraDatabase, connect, databaseUrl, type Db } from "@ystara/db";
import { ROLES } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";
import { discoveryRoutes } from "./routes/discovery.js";

/**
 * API entry point. Every route is under /api; anything else is the web app
 * (apps/web, built into apps/web/dist), so one port serves both and the
 * browser never makes a cross-origin call. Routes arrive per phase:
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

export interface ServerOptions {
  logger?: boolean;
  /** The built web app (apps/web/dist). Without it, only /api is served. */
  webRoot?: string;
}

export async function buildServer(deps: { db: Db; queue: JobQueue }, opts: ServerOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? true });
  await app.register(helmet);

  app.setErrorHandler((err: FastifyError | ZodError, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err.code === "23505") return reply.code(409).send({ error: "That name is already taken" }); // unique_violation
    reply.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : "Internal error" });
  });

  await app.register(
    async (api) => {
      api.get("/health", async () => ({ status: "ok", service: "ystara-api", time: new Date().toISOString() }));
      api.get("/meta", async () => ({ roles: ROLES, version: process.env.npm_package_version ?? "dev" }));
      await api.register(discoveryRoutes(deps.db, deps.queue));
    },
    { prefix: "/api" },
  );

  if (opts.webRoot) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      // File names under assets/ carry a content hash, so they can be cached for good; index.html never.
      setHeaders: (reply, file) =>
        reply.header("cache-control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache"),
    });
  }

  // The web app's own routes (/tenants/..., /scans/...) are pages, not files: answer them with index.html.
  app.setNotFoundHandler((req, reply) => {
    const isPage = opts.webRoot && req.method === "GET" && !req.url.startsWith("/api/") && req.headers.accept?.includes("text/html");
    if (isPage) return reply.header("cache-control", "no-cache").sendFile("index.html");
    return reply.code(404).send({ error: `${req.method} ${req.url.split("?")[0]} not found` });
  });

  return app;
}

// pathToFileURL keeps this check working on Windows (C:\... vs file:///C:/...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));

  const url = databaseUrl();
  const db = connect(url);
  await assertYstaraDatabase(db); // before pg-boss creates its own tables in someone else's database
  const boss = new PgBoss(url);
  boss.on("error", (err) => console.error("[api] queue error", err));
  await boss.start(); // queues are created by `npm run db:migrate`

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  const app = await buildServer({ db, queue: boss }, { webRoot: existsSync(webRoot) ? webRoot : undefined });
  await app.listen({ port: Number(process.env.YSTARA_API_PORT ?? 4000), host: process.env.API_HOST ?? "127.0.0.1" });
}
