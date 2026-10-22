import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { auditUserEmails, listAuditEvents, type AuditQuery, type Db } from "@ystara/db";
import { AUDIT_ACTIONS, AUDIT_GROUPS, toCsv, type AuditEvent, type AuditPage } from "@ystara/shared";
import { signedIn } from "../auth/access.js";

/**
 * The account's audit log (audit.ts writes it), for admins ("audit.read"):
 * a page of events at a time, newest first, and the same filtered list as CSV.
 */
const read = { access: "audit.read" } as const;
const PAGE = 100;
/** One export holds at most this many events; narrow the dates for more. */
export const CSV_MAX_EVENTS = 50_000;

const Filters = z.object({
  before: z.string().regex(/^\d{1,19}$/).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  user: z.string().trim().toLowerCase().max(254).optional(),
  group: z.enum(AUDIT_GROUPS).optional(),
});

function queryOf(req: FastifyRequest, limit: number): AuditQuery {
  const f = Filters.parse(req.query);
  const actions = f.group && Object.entries(AUDIT_ACTIONS).flatMap(([key, a]) => (a?.group === f.group ? [key] : []));
  return { accountId: signedIn(req).accountId, before: f.before, from: f.from, to: f.to, userEmail: f.user || undefined, actions, limit };
}

/** "Changed the member's role or spaces: someone@example.com", for the CSV's What column. */
const describe = (e: AuditEvent) => (e.target?.name ? `${e.label}: ${e.target.name}` : e.label);

export function auditRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    app.get("/audit", { config: read }, async (req) => {
      const events = await listAuditEvents(db, queryOf(req, PAGE + 1));
      return { events: events.slice(0, PAGE), next: events.length > PAGE ? events[PAGE - 1].id : null } satisfies AuditPage;
    });

    // Who appears in the log, for the page's filter.
    app.get("/audit/users", { config: read }, async (req) => auditUserEmails(db, signedIn(req).accountId));

    app.get("/audit.csv", { config: read }, async (req, reply) => {
      const query = queryOf(req, CSV_MAX_EVENTS);
      const events = await listAuditEvents(db, query);
      const csv = toCsv(
        ["When (UTC)", "Who", "What", "Group", "Target", "Target ID", "Details", "IP address"],
        events.map((e) => [e.at, e.userEmail, describe(e), e.group, e.target?.name ?? null, e.target?.id ?? null, e.detail && JSON.stringify(e.detail), e.ip]),
      );
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="ystara-audit-${day}.csv"`)
        .header("cache-control", "no-store")
        .send(csv);
    });
  };
}
