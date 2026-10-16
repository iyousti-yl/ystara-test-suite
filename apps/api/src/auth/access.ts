import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { findSession, type Db, type Session } from "@ystara/db";
import { can, type Permission } from "@ystara/shared";

/**
 * Who may call each API route, checked before the route runs. A route says it
 * in its config; without one it needs a signed-in user:
 *
 *   app.get("/tenants", { config: { access: "pipelines.read" } }, ...)
 *
 *   "public"     anyone (health, sign-in, invitation links)
 *   "pending"    password checked, authenticator code still to come
 *   "signed-in"  password and code checked (the default)
 *   a Permission signed in, and the role in the current account allows it (packages/shared/src/roles.ts)
 *
 * A route only sees its own account's data: it reads the account from
 * req.auth, never from the request, and answers 404 for another account's ids.
 */
export type Access = "public" | "pending" | "signed-in" | Permission;

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
/** A sign-in lasts one working day. */
export const SESSION_MINUTES = 12 * 60;

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
    if (session?.verified) req.auth = session;
    else if (session) req.pending = session;

    const access = req.routeOptions.config.access ?? "signed-in";
    if (access === "public") return;
    if (access === "pending") {
      if (!req.pending) return reply.code(401).send({ error: "Sign in with your email and password first" });
      return;
    }
    if (!req.auth) return reply.code(401).send({ error: "Sign in to continue" });
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

export function setSessionCookie(reply: FastifyReply, token: string, minutes: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/api",
    httpOnly: true, // scripts on the page can't read it
    sameSite: "strict", // other sites can't make the browser send it
    secure: "auto", // https only, once Ystara is served over https
    maxAge: minutes * 60,
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
