import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import PgBoss from "pg-boss";
import { ZodError } from "zod";
import { assertMasterKey, assertYstaraDatabase, connect, databaseUrl, lastHeartbeat, type Db, type Queryable } from "@ystara/db";
import { postToTeams, ROLES, type PostToTeams } from "@ystara/shared";
import { appVersion, loadLocalEnv } from "@ystara/shared/env";
import { masterKeyFromEnv, secretBox, type SecretBox } from "@ystara/shared/secrets";
import { installAudit } from "./audit.js";
import { installAccess } from "./auth/access.js";
import { PasswordCheckBusy } from "./auth/passwords.js";
import { checkClaudeKey, claudeDrafter, currentClaudeKey, keyFromEnv, type ClaudeAccess, type ScenarioDrafter } from "./drafting.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { databaseUserRoutes } from "./routes/database-users.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { operatorRoutes } from "./routes/operator.js";
import { resultRoutes } from "./routes/results.js";
import { scenarioRoutes } from "./routes/scenarios.js";
import { snapshotRoutes } from "./routes/snapshots.js";
import { teamRoutes } from "./routes/team.js";
import { teamsRoutes } from "./routes/teams.js";

/**
 * API entry point. Every route is under /api; anything else is the web app
 * (apps/web, built into apps/web/dist), so one port serves both and the
 * browser never makes a cross-origin call. Routes arrive per phase:
 *   phase 1: tenants, scans, lineage, pipelines (routes/discovery.ts),
 *            each tenant's technical client (routes/connections.ts),
 *            sign-in and invitations (routes/auth.ts), users and roles (routes/team.ts),
 *            the operator panel (routes/operator.ts)
 *   phase 2: each space's database user (routes/database-users.ts), snapshots (routes/snapshots.ts)
 *   phase 3: scenarios and suites (routes/scenarios.ts), Teams alerts (routes/teams.ts)
 *   phase 4: sign-offs, history and the report (routes/results.ts), the audit log (routes/audit.ts)
 *
 * What a user may reach is decided in scope.ts (their account, and the spaces
 * they see); every request that changes something is logged by audit.ts.
 *
 * Every route needs a signed-in user unless it says otherwise; auth/access.ts
 * explains the rules. The API still listens on 127.0.0.1 only (inside Docker
 * it listens on all interfaces, and docker-compose.yml publishes it on
 * 127.0.0.1 only): it speaks plain http, so it stays local until it is hosted
 * behind https.
 */

/** Where background jobs go: pg-boss in the running app, a list in tests. */
export interface JobQueue {
  /** With `tx`, the job is sent on that transaction: it exists only if the row it works on is saved too. */
  send(name: string, data: object, tx?: Queryable): Promise<unknown>;
}

/** A worker that took no tick for this long is reported as silent by /api/health/worker. */
const WORKER_SILENT_MS = 3 * 60_000;

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

/**
 * `claude` says where drafting with Claude gets its key (by default only the
 * operator's, from the database); `drafter` replaces the drafting itself in tests,
 * and `teams` the posts to Microsoft Teams.
 */
export async function buildServer(
  deps: { db: Db; queue: JobQueue; secrets: SecretBox; claude?: ClaudeAccess; drafter?: ScenarioDrafter; teams?: PostToTeams },
  opts: ServerOptions = {},
) {
  const claude = deps.claude ?? { check: checkClaudeKey };
  const drafter = deps.drafter ?? claudeDrafter(() => currentClaudeKey(deps.db, deps.secrets, claude));
  const logger = opts.logger === false ? false : { serializers: { req: requestForLog }, ...(opts.logStream && { stream: opts.logStream }) };
  // A count of proxies: believe the forwarded addresses up to that many hops back (what Fastify does with a number,
  // which its types don't take).
  const { trustProxy = false } = opts;
  const app = Fastify({
    logger,
    trustProxy: typeof trustProxy === "number" ? (_address: string, hop: number) => hop < trustProxy : trustProxy,
    // Each request gets an id of its own (never one a client sends), in the log and in the X-Request-Id answer header,
    // so "something went wrong" from a customer can be found in the log.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // The app uses no camera, microphone, location or payment, so no page of it (or anything injected into one) may.
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    // API answers hold account data: no browser or proxy keeps a copy.
    if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });
  // An empty JSON body is no body: scripts often send `content-type: application/json` on a DELETE. Any other
  // body is parsed as Fastify does by default, refusing __proto__ and constructor keys.
  const json = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body: string, done) => (body === "" ? done(null, undefined) : json(req, body, done)));
  await app.register(cookie);
  // Only routes that ask for it are limited (sign-in, codes, invitation links, drafting). The answer says when to try again.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, limit) => Object.assign(new Error(`Too many tries in a short time. Try again in ${limit.after}.`), { statusCode: limit.statusCode }),
  });
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

  app.setErrorHandler((err: FastifyError | ZodError, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err instanceof PasswordCheckBusy) return reply.code(503).header("retry-after", "5").send({ error: err.message });
    if (err.code === "23505") return reply.code(409).send({ error: "That name is already taken" }); // unique_violation
    if (err.statusCode && err.statusCode < 500) {
      reply.log.info({ err }, "request refused");
      return reply.code(err.statusCode).send({ error: err.message });
    }
    reply.log.error(err);
    // Nothing of the cause reaches the browser; the id finds it in the log.
    return reply.code(500).send({ error: `Something went wrong on Ystara's side. If it happens again, give Ystara's support this reference: ${req.id}`, requestId: req.id });
  });

  await app.register(
    async (api) => {
      installAccess(api, deps.db);
      installAudit(api, deps.db);
      const open = { config: { access: "public" } } as const;
      // For Docker's health check and an uptime monitor: the API answers and reaches its database (503 when it can't).
      api.get("/health", open, async (_req, reply) => {
        const database = await reachable(deps.db);
        return reply.code(database ? 200 : 503).send({ status: database ? "ok" : "unavailable", service: "ystara-api", version: appVersion(), database: database ? "ok" : "unreachable", time: new Date().toISOString() });
      });
      // For the uptime monitor: a worker takes jobs (it took the once-a-minute tick lately). 503 when none did for 3 minutes.
      api.get("/health/worker", open, async (_req, reply) => {
        const beat = await lastHeartbeat(deps.db).catch(() => undefined);
        const working = !!beat && Date.now() - beat.seenAt.getTime() < WORKER_SILENT_MS;
        return reply.code(working ? 200 : 503).send({ status: working ? "ok" : "silent", lastSeenAt: beat?.seenAt ?? null, version: beat?.version ?? null });
      });
      api.get("/meta", open, async () => ({ roles: ROLES, version: appVersion() }));
      await api.register(authRoutes(deps.db, deps.secrets));
      await api.register(teamRoutes(deps.db));
      await api.register(operatorRoutes(deps.db, deps.secrets, claude));
      await api.register(discoveryRoutes(deps.db, deps.queue));
      await api.register(connectionRoutes(deps.db, deps.queue, deps.secrets));
      await api.register(databaseUserRoutes(deps.db, deps.queue, deps.secrets));
      await api.register(snapshotRoutes(deps.db, deps.queue));
      await api.register(scenarioRoutes(deps.db, deps.queue, drafter));
      await api.register(teamsRoutes(deps.db, deps.secrets, deps.teams ?? postToTeams));
      await api.register(resultRoutes(deps.db));
      await api.register(auditRoutes(deps.db));
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

/** Whether the database answers within 3 seconds. */
async function reachable(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), 3000)));
  const answered = db.query("select 1").then(() => true, () => false);
  return Promise.race([answered, late]).finally(() => clearTimeout(timer));
}

// pathToFileURL keeps this check working on Windows (C:\... vs file:///C:/...).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadLocalEnv(fileURLToPath(new URL("../../../", import.meta.url)));
  const secrets = secretBox(masterKeyFromEnv()); // before anything else, so a missing key stops the start at once
  const trustProxy = trustProxyFromEnv(); // and so does a bad YSTARA_TRUST_PROXY

  const url = databaseUrl();
  // No request needs a statement longer than 30 seconds; one that runs longer is stopped instead of holding a connection.
  const db = connect(url, { application: "ystara-api", statementTimeoutMs: 30_000 });
  await assertYstaraDatabase(db); // before pg-boss creates its own tables in someone else's database
  await assertMasterKey(db, secrets); // a wrong key would fail every sign-in code later, one by one
  // The API only sends jobs: the once-a-minute schedule tick is sent by the workers, so none piles up while no worker runs.
  const boss = new PgBoss({ connectionString: url, schedule: false });
  boss.on("error", (err) => console.error("[api] queue error", err));
  await boss.start(); // queues are created by `npm run db:migrate`

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  const claude = { fromEnvironment: keyFromEnv(), check: checkClaudeKey };
  const queue: JobQueue = {
    send: (name, data, tx) => boss.send(name, data, tx ? { db: { executeSql: (text: string, values: unknown[]) => tx.query(text, values) } } : {}),
  };
  const app = await buildServer({ db, queue, secrets, claude }, { webRoot: existsSync(webRoot) ? webRoot : undefined, trustProxy });
  if (claude.fromEnvironment) app.log.info("Drafting scenarios with Claude uses this server's ANTHROPIC_API_KEY");
  await app.listen({ port: Number(process.env.YSTARA_API_PORT ?? 4000), host: process.env.API_HOST ?? "127.0.0.1" });
  app.log.info({ version: appVersion() }, "started");

  // A deploy stops the API with SIGTERM: it takes no new request, lets those under way finish (10 seconds at most),
  // then closes its connections. Caddy holds requests meanwhile and sends them to the new API (lb_try_duration).
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      app.log.info({ signal }, "stopping");
      setTimeout(() => process.exit(0), 10_000).unref();
      await app.close();
      await boss.stop({ graceful: false, wait: true });
      await db.close();
      process.exit(0);
    });
  }
}
