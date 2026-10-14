import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { ROLES } from "@ystara/shared";

/**
 * API entry point. Phase 0 exposes only health and metadata endpoints so the
 * deployment pipeline can be proven end to end. Real routes arrive per phase:
 *   phase 0: auth, accounts, memberships
 *   phase 1: tenants, scans, lineage, pipelines
 *   phase 2: snapshots, runs, alerts
 *   phase 3: scenarios
 */
export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(cors, { origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" });

  app.get("/health", async () => ({ status: "ok", service: "ystara-api", time: new Date().toISOString() }));
  app.get("/meta", async () => ({ roles: ROLES, version: process.env.npm_package_version ?? "dev" }));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
}
