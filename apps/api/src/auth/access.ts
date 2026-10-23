import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deleteSession, findSession, touchSession, type Db, type Session } from "@ystara/db";
import { ACTIVITY_HEADER, can, IDLE_MINUTES, type Permission } from "@ystara/shared";

/**
 * Who may call each API route, checked before the route runs. A route says it
 * in its config; without one it needs a signed-in user:
 *
 *   app.get("/tenants", { config: { access: "pipelines.read" } }, ...)
 *
 *   "public"     anyone (health, sign-in, invitation links)
 *   "pending"    password checked, authenticator code still to come
 *   "signed-in"  password and code checked (the default)
 *   "operator"   signed in as Ystara's operator (the operator panel, routes/operator.ts)
 *   a Permission signed in, and the role in the current account allows it (packages/shared/src/roles.ts)
 *
 * A route only sees its own account's data: it reads the account from
 * req.auth, never from the request, and answers 404 for another account's ids.
 */
export type Access = "public" | "pending" | "signed-in" | "operator" | Permission;

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    /** The signed-in user (password and code checked), on any route. */
    auth?: Session;
    /** A sign-in waiting for its authenticator code. */
    pending?: Session;
    /** The session cookie's token, when there is one. */
    sessionToken?: string;
  }
}

export const SESSION_COOKIE = "ystara_session";
/** Time to type the authenticator code after the password. */
export const PENDING_MINUTES = 10;
/** A sign-in lasts one working day at most, and ends sooner after IDLE_MINUTES without use. */
export const SESSION_MINUTES = 12 * 60;
/** How often a session's last use is written: once a minute is enough to measure an hour. */
const TOUCH_EVERY_MS = 60_000;
/**
 * Over https (YSTARA_PUBLIC_URL says so on a server), the cookie is only ever sent over https. Otherwise Fastify
 * decides per request ("auto"), which also works on http://127.0.0.1 on a developer's machine.
 */
const SECURE_COOKIE = process.env.YSTARA_PUBLIC_URL?.startsWith("https://") ? true : "auto";

export function installAccess(app: FastifyInstance, db: Db): void {
  app.addHook("onRequest", async (req, reply) => {
    // Browsers send Origin with every POST, PATCH and DELETE. Refusing other sites' origins stops a page elsewhere
    // from acting with the user's cookie (the cookie's SameSite=Strict already does; this is a second lock).
    const origin = req.headers.origin;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin !== undefined && !sameHost(origin, req.host)) {
      return reply.code(403).send({ error: "Requests from other sites are refused" });
    }

    const token = req.cookies[SESSION_COOKIE];
    const session = token ? await findSession(db, token) : undefined;
    req.sessionToken = token;
    const access = req.routeOptions.config.access ?? "signed-in";
    if (session?.verified && Date.now() - session.lastSeenAt.getTime() > IDLE_MINUTES * 60_000) {
      // Unused for an hour: the session ends here, whatever the route.
      await deleteSession(db, token!);
      clearSessionCookie(reply);
      if (access === "public") return;
      return reply.code(401).send({ error: `You were signed out after ${IDLE_MINUTES} minutes without using Ystara. Sign in again to continue.` });
    }
    if (session?.verified) req.auth = session;
    else if (session) req.pending = session;
    // Use is a request that changes something, or one the page sends while someone is at it; polling alone isn't.
    const used = !["GET", "HEAD"].includes(req.method) || req.headers[ACTIVITY_HEADER] === "1";
    if (session?.verified && used && Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) await touchSession(db, token!);

    if (access === "public") return;
    if (access === "pending") {
      if (!req.pending) return reply.code(401).send({ error: "Sign in with your email and password first" });
      return;
    }
    if (!req.auth) return reply.code(401).send({ error: "Sign in to continue" });
    if (access === "operator") {
      if (!req.auth.operator) return reply.code(403).send({ error: "Only Ystara's operator can do this" });
      return;
    }
    if (access !== "signed-in" && !can(req.auth.role, access)) {
      return reply.code(403).send({ error: `Your role (${req.auth.role.replace("_", " ")}) can't do this` });
    }
  });
}

/** The signed-in user, on a route that requires one. */
export function signedIn(req: FastifyRequest): Session {
  if (!req.auth) throw new Error(`${req.method} ${req.url} reads req.auth but its access is "public" or "pending"`);
  return req.auth;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/api",
    httpOnly: true, // scripts on the page can't read it
    sameSite: "strict", // other sites can't make the browser send it
    secure: SECURE_COOKIE, // https only, once Ystara is served over https
    // No maxAge: the browser forgets the cookie when it closes. The server ends the session too, at its
    // expires_at or after an hour without use, whichever comes first.
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/api" });
}

/** Whether the page's origin is this server (the Host header, normalised the same way, so http://x:80 equals x). */
function sameHost(origin: string, host: string): boolean {
  try {
    const page = new URL(origin);
    return page.host === new URL(`${page.protocol}//${host}`).host;
  } catch {
    return false;
  }
}
