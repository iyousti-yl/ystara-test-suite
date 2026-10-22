import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditTarget, recordAuditEvent, type Db } from "@ystara/db";
import { AUDIT_ACTIONS, auditKey, type AuditAction, type AuditTarget } from "@ystara/shared";

/**
 * The audit log: after each request that changed something answers with
 * success, one event says who did what, to what, when and from where
 * (AUDIT_ACTIONS in @ystara/shared says how each route reads). Requests that
 * fail write nothing: they changed nothing.
 *
 * What a request acts on is read before it runs (its name or email), so the
 * event still names a pipeline the request deleted. Only the body fields the
 * action lists are kept, never a secret or a scenario's test rows.
 *
 * Every route that isn't a GET must be in AUDIT_ACTIONS: the API refuses to
 * start otherwise, so a new route can't go unlogged by mistake.
 */
declare module "fastify" {
  interface FastifyRequest {
    /** Who acted, when the route signs someone in or moves them to another account (routes/auth.ts). */
    auditActor?: { userId: string; accountId: string | null };
    auditTarget?: AuditTarget;
  }
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export function installAudit(app: FastifyInstance, db: Db): void {
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (READS.has(method)) continue;
      const key = auditKey(method, route.url);
      if (!(key in AUDIT_ACTIONS)) throw new Error(`${key} is not in AUDIT_ACTIONS (packages/shared/src/audit.ts): say how it reads in the audit log, or null`);
    }
  });

  app.addHook("preHandler", async (req) => {
    const target = actionOf(req)?.target;
    const id = target && (req.params as Record<string, string | undefined>)[target.param];
    if (target && id) req.auditTarget = await auditTarget(db, target.kind, id);
  });

  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 400) return;
    const action = actionOf(req);
    if (!action) return;
    const actor = req.auditActor ?? (req.auth && { userId: req.auth.userId, accountId: req.auth.accountId });
    if (!actor) return;
    try {
      await recordAuditEvent(db, {
        // The operator panel acts across accounts, so its events belong to none of them.
        accountId: action.group === "Operator" ? null : actor.accountId,
        userId: actor.userId,
        action: auditKey(req.method, req.routeOptions.url!),
        target: req.auditTarget ?? null,
        detail: detailOf(req, action),
        ip: req.ip ?? null,
      });
    } catch (err) {
      // The request already did its work; a lost event is logged for the operator rather than failing it afterwards.
      req.log.error({ err, action: auditKey(req.method, req.routeOptions.url!) }, "audit event not written");
    }
  });
}

function actionOf(req: FastifyRequest): AuditAction | null | undefined {
  if (READS.has(req.method) || !req.routeOptions.url) return undefined;
  return AUDIT_ACTIONS[auditKey(req.method, req.routeOptions.url)];
}

/** The listed body fields and the route's other parameters, except the target's and a link's token. Null when there are none. */
function detailOf(req: FastifyRequest, action: AuditAction): Record<string, unknown> | null {
  const detail: Record<string, unknown> = {};
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const field of action.fields ?? []) if (body[field] !== undefined) detail[field] = body[field];
  for (const [name, value] of Object.entries((req.params ?? {}) as Record<string, unknown>)) {
    if (name !== action.target?.param && name !== "token") detail[name] = value;
  }
  return Object.keys(detail).length ? detail : null;
}
