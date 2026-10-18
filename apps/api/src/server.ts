import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import PgBoss from "pg-boss";
import { ZodError } from "zod";
import { assertYstaraDatabase, connect, databaseUrl, type Db } from "@ystara/db";
import { ROLES } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";
import { masterKeyFromEnv, secretBox, type SecretBox } from "@ystara/shared/secrets";
import { installAccess } from "./auth/access.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { databaseUserRoutes } from "./routes/database-users.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { operatorRoutes } from "./routes/operator.js";
import { snapshotRoutes } from "./routes/snapshots.js";
import { teamRoutes } from "./routes/team.js";

/**
 * API entry point. Every route is under /api; anything else is the web app
 * (apps/web, built into apps/web/dist), so one port serves both and the
 * browser never makes a cross-origin call. Routes arrive per phase:
 *   phase 1: tenants, scans, lineage, pipelines (routes/discovery.ts),
 *            each tenant's technical client (routes/connections.ts),
 *            sign-in and invitations (routes/auth.ts), users and roles (routes/team.ts),
 *            the operator panel (routes/operator.ts)
 *   phase 2: each space's database user (routes/database-users.ts), snapshots (routes/snapshots.ts)
 *   later:   comparisons, runs, alerts; scenarios
 *
 * Every route needs a signed-in user unless it says otherwise; auth/access.ts
 * explains the rules. The API still listens on 127.0.0.1 only (inside Docker
 * it listens on all interfaces, and docker-compose.yml publishes it on
 * 127.0.0.1 only): it speaks plain http, so it stays local until it is hosted
 * behind https.
 */

/** Where background jobs go: pg-boss in the running app, a list in tests. */
export interface JobQueue {
  send(name: string, data: object): Promise<unknown>;
}

export interface ServerOptions {
  logger?: boolean;
  /** Where log lines go instead of stdout (tests). */
  logStream?: NodeJS.WritableStream;
  /** The built web app (apps/web/dist). Without it, only /api is served. */
  webRoot?: string;
  /** Which proxies in front of the API may say who the client is: see trustProxyFromEnv. Default: none. */
  trustProxy?: number | string[] | false;
}

/**
 * YSTARA_TRUST_PROXY: which proxy in front of the API may tell it the client's address (X-Forwarded-For),
 * so the sign-in limits count per real client and not per proxy. Unset: none, for an API reached directly
 * (as on 127.0.0.1). A number: that many proxies in front (1 for Caddy or nginx on the same machine).
 * Otherwise: the proxies' addresses or ranges, separated by commas (e.g. 10.0.0.0/8). "true" is refused:
 * trusting every sender would let any client choose its own address and get around the limits.
 */
export function trustProxyFromEnv(value = process.env.YSTARA_TRUST_PROXY): number | string[] | false {
  const v = value?.trim();
  if (!v) return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (["true", "*", "all"].includes(v.toLowerCase())) {
    throw new Error("YSTARA_TRUST_PROXY must name the proxies in front of the API: their number (e.g. 1) or their addresses. Trusting every sender would let any client choose its own address.");
  }
  return v.split(",").map((part) => part.trim()).filter(Boolean);
}

/**
 * Some links work like a password for days (invitation and reset links), so their token never goes into the log:
 * it is cut from the path, both for the API call and for the web app's page.
 */
const TOKEN_IN_PATH = /\/(invitations|invite|resets|reset)\/[^/?#]+/g;
export const pathForLog = (url: string) => url.replace(TOKEN_IN_PATH, "/$1/<token>");

/** Fastify's own request log entry, with the path cleaned. */
const requestForLog = (req: FastifyRequest) => ({
  method: req.method,
  url: pathForLog(req.url),
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});

export async function buildServer(deps: { db: Db; queue: JobQueue; secrets: SecretBox }, opts: ServerOptions = {}) {
  const logger = opts.logger === false ? false : { serializers: { req: requestForLog }, ...(opts.logStream && { stream: opts.logStream }) };
  // A count of proxies: believe the forwarded addresses up to that many hops back (what Fastify does with a number,
  // which its types don't take).
  const { trustProxy = false } = opts;
  const app = Fastify({ logger, trustProxy: typeof trustProxy === "number" ? (_address: string, hop: number) => hop < trustProxy : trustProxy });
  // An empty JSON body is no body: scripts often send `content-type: application/json` on a DELETE. Any other
  // body is parsed as Fastify does by default, refusing __proto__ and constructor keys.
  const json = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body: string, done) => (body === "" ? done(null, undefined) : json(req, body, done)));
  await app.register(cookie);
  // Only routes that ask for it are limited (sign-in, codes, invitation links).
  await app.register(rateLimit, { global: false });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        // The web app bundles everything it shows (decision 15), so the browser may only load fonts and
        // styles from Ystara itself: a change that brings back a CDN fails visibly instead of leaking.
        "font-src": ["'self'", "data:"],
        // 'unsafe-inline': UI5 and React Flow set styles from script (style attributes, <style> elements).
        "style-src": ["'self'", "'unsafe-inline'"],
        // Served over plain http on 127.0.0.1 until it is hosted; Safari applies the upgrade there and breaks.
        "upgrade-insecure-requests": null,
      },
    },
  });

  app.setErrorHandler((err: FastifyError | ZodError, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err.code === "23505") return reply.code(409).send({ error: "That name is already taken" }); // unique_violation
    reply.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : "Internal error" });
  });

  await app.register(
    async (api) => {
      installAccess(api, deps.db);
      const open = { config: { access: "public" } } as const;
      api.get("/health", open, async () => ({ status: "ok", service: "ystara-api", time: new Date().toISOString() }));
      api.get("/meta", open, async () => ({ roles: ROLES, version: process.env.npm_package_version ?? "dev" }));
      await api.register(authRoutes(deps.db, deps.secrets));
      await api.register(teamRoutes(deps.db));
      await api.register(operatorRoutes(deps.db));
      await api.register(discoveryRoutes(deps.db, deps.queue));
      await api.register(connectionRoutes(deps.db, deps.queue, deps.secrets));
      await api.register(databaseUserRoutes(deps.db, deps.queue, deps.secrets));
      await api.register(snapshotRoutes(deps.db, deps.queue));
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
  const secrets = secretBox(masterKeyFromEnv()); // before anything else, so a missing key stops the start at once
  const trustProxy = trustProxyFromEnv(); // and so does a bad YSTARA_TRUST_PROXY

  const url = databaseUrl();
  const db = connect(url);
  await assertYstaraDatabase(db); // before pg-boss creates its own tables in someone else's database
  // The API only sends jobs: the once-a-minute schedule tick is sent by the workers, so none piles up while no worker runs.
  const boss = new PgBoss({ connectionString: url, schedule: false });
  boss.on("error", (err) => console.error("[api] queue error", err));
  await boss.start(); // queues are created by `npm run db:migrate`

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  const app = await buildServer({ db, queue: boss, secrets }, { webRoot: existsSync(webRoot) ? webRoot : undefined, trustProxy });
  await app.listen({ port: Number(process.env.YSTARA_API_PORT ?? 4000), host: process.env.API_HOST ?? "127.0.0.1" });
}
