import { AUDIT_ACTIONS, type AuditEvent, type AuditTarget, type AuditTargetKind } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * The audit log (migration 014). Events are only added, never changed; they go
 * with their account when it is deleted. AUDIT_ACTIONS in @ystara/shared says
 * how each action reads.
 */
export type { AuditEvent, AuditTarget };

export interface NewAuditEvent {
  /** Null for what belongs to no account: the operator panel. */
  accountId: string | null;
  userId: string | null;
  action: string;
  target: AuditTarget | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

/** Adds an event, with the user's email as it is now, so it still reads once the user is gone. */
export async function recordAuditEvent(db: Queryable, e: NewAuditEvent): Promise<void> {
  await db.query(
    `insert into audit_events (account_id, user_id, user_email, action, target, detail, ip)
     values ($1, $2, (select email from users where id = $2), $3, $4, $5, $6)`,
    [e.accountId, e.userId, e.action, e.target && JSON.stringify(e.target), e.detail && JSON.stringify(e.detail), e.ip],
  );
}

/** What the Audit page filters on. `before` is an event id: the page then starts with the next older event. */
export interface AuditQuery {
  accountId: string;
  before?: string;
  from?: Date;
  to?: Date;
  userEmail?: string;
  /** Only these actions (AUDIT_ACTIONS keys). */
  actions?: string[];
  limit: number;
}

interface Row {
  id: string;
  at: Date;
  user_email: string | null;
  action: string;
  target: AuditTarget | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

/** An account's events, newest first. */
export async function listAuditEvents(db: Queryable, q: AuditQuery): Promise<AuditEvent[]> {
  const where = ["account_id = $1"];
  const params: unknown[] = [q.accountId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.before) add("id < ?", q.before);
  if (q.from) add("at >= ?", q.from);
  if (q.to) add("at < ?", q.to);
  if (q.userEmail) add("user_email = ?", q.userEmail.toLowerCase());
  if (q.actions) add("action = any(?)", q.actions);
  params.push(q.limit);
  const { rows } = await db.query<Row>(
    // Ordered by the bigint id, not by the text it is sent as (which would put "99" before "104").
    `select e.id::text as id, at, user_email, action, target, detail, ip from audit_events e where ${where.join(" and ")} order by e.id desc limit $${params.length}`,
    params,
  );
  return rows.map((r) => {
    const action = AUDIT_ACTIONS[r.action];
    return { id: r.id, at: r.at, userEmail: r.user_email, action: r.action, label: action?.label ?? r.action, group: action?.group ?? null, target: r.target, detail: r.detail, ip: r.ip };
  });
}

/** How many times an account did `action` since `since`: drafting with Claude counts its drafts of the day this way. */
export async function countAuditEvents(db: Queryable, q: { accountId: string; action: string; since: Date }): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from audit_events where account_id = $1 and action = $2 and at >= $3", [q.accountId, q.action, q.since]);
  return rows[0]!.n;
}

/** The accounts an operator event concerns, so each sees it in its own log: the account itself, or each one the user belongs to. */
export async function accountsConcerned(db: Queryable, target: AuditTarget): Promise<string[]> {
  if (target.kind === "account") return [target.id];
  if (target.kind !== "user") return [];
  const { rows } = await db.query<{ account_id: string }>("select account_id from memberships where user_id = $1", [target.id]);
  return rows.map((r) => r.account_id);
}

/** The emails that appear in an account's log, for the Audit page's filter. */
export async function auditUserEmails(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_email: string }>(
    "select distinct user_email from audit_events where account_id = $1 and user_email is not null order by user_email",
    [accountId],
  );
  return rows.map((r) => r.user_email);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a request is about to act on, by its id from the route: its name (or
 * email) now, before the request changes or deletes it. Null name when there
 * is no such row; the route then answers 404 and no event is written.
 */
export async function auditTarget(db: Queryable, kind: AuditTargetKind, id: string): Promise<AuditTarget> {
  if (!UUID.test(id)) return { kind, id, name: null };
  const one = async <T>(sql: string): Promise<T | undefined> => (await db.query<T>(sql, [id])).rows[0];
  switch (kind) {
    case "tenant":
      return { kind, id, name: (await one<{ name: string }>("select name from tenants where id = $1"))?.name ?? null };
    case "pipeline": {
      const r = await one<{ name: string; tenant_id: string }>("select name, tenant_id from pipelines where id = $1");
      return { kind, id, name: r?.name ?? null, ...(r && { tenantId: r.tenant_id }) };
    }
    case "scenario": {
      const r = await one<{ name: string; tenant_id: string; pipeline_id: string }>("select name, tenant_id, pipeline_id from scenarios where id = $1");
      return { kind, id, name: r?.name ?? null, ...(r && { tenantId: r.tenant_id, pipelineId: r.pipeline_id }) };
    }
    case "member":
    case "user":
      return { kind, id, name: (await one<{ email: string }>("select email from users where id = $1"))?.email ?? null };
    case "invitation":
      return { kind, id, name: (await one<{ email: string }>("select email from invitations where id = $1"))?.email ?? null };
    case "account":
      return { kind, id, name: (await one<{ name: string }>("select name from accounts where id = $1"))?.name ?? null };
  }
}
