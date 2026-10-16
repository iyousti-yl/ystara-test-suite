import type { ConnectionSpace, ConnectionStatus, TenantConnection } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Each tenant's technical OAuth client and the spaces it is meant to scan
 * (migration 005; the lifecycle is on TenantConnection in @ystara/shared). The
 * secret arrives here already sealed with MASTER_KEY: this package never sees
 * it in clear text, and only `getConnectionLogin` (for the worker) reads it back.
 */
export type { ConnectionSpace, ConnectionStatus, TenantConnection };

/** What the worker needs to log in and check the spaces. `sealedSecret` is still sealed. */
export interface ConnectionLogin {
  tenantId: string;
  clientId: string;
  sealedSecret: string;
  tokenUrl: string;
  status: ConnectionStatus;
  /** The spaces to check, in the admin's order. */
  spaces: string[];
  /** Which client and space list this is: a check records its result only if neither has changed since. */
  updatedAt: Date;
}

interface Row {
  tenant_id: string;
  client_id: string;
  client_secret: string;
  token_url: string;
  status: ConnectionStatus;
  checked_at: Date | null;
  error: string | null;
  spaces: ConnectionSpace[];
  updated_at: Date;
}

const toConnection = (r: Row): TenantConnection => ({
  tenantId: r.tenant_id,
  clientId: r.client_id,
  tokenUrl: r.token_url,
  status: r.status,
  checkedAt: r.checked_at,
  error: r.error,
  spaces: r.spaces,
  updatedAt: r.updated_at,
});

/** The spaces as the admin named them, none checked yet (the jsonb that goes into `spaces`). */
const unchecked = (spaces: string[]) => JSON.stringify(spaces.map((space): ConnectionSpace => ({ space, readable: null, error: null })));

/**
 * Saves a new or changed client with the spaces to scan. It starts as "checking", every space unchecked, until the worker has tried it.
 * `updated_at` is kept to the millisecond, the precision a JavaScript Date carries back in `recordConnectionCheck`.
 */
export async function setConnection(
  db: Queryable,
  input: { tenantId: string; clientId: string; sealedSecret: string; tokenUrl: string; spaces: string[]; updatedBy: string | null },
): Promise<TenantConnection> {
  const { rows } = await db.query<Row>(
    `insert into tenant_connections (tenant_id, client_id, client_secret, token_url, spaces, updated_by, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, date_trunc('milliseconds', clock_timestamp()))
     on conflict (tenant_id) do update set client_id = $2, client_secret = $3, token_url = $4, spaces = $5::jsonb, updated_by = $6,
       status = 'checking', checked_at = null, error = null, updated_at = excluded.updated_at
     returning *`,
    [input.tenantId, input.clientId, input.sealedSecret, input.tokenUrl, unchecked(input.spaces), input.updatedBy],
  );
  return toConnection(rows[0]);
}

/** Changes only the spaces to scan (the secret stays as it is), to be checked again. Undefined when the tenant has no client. */
export async function setConnectionSpaces(db: Queryable, tenantId: string, spaces: string[], updatedBy: string | null): Promise<TenantConnection | undefined> {
  const { rows } = await db.query<Row>(
    `update tenant_connections set spaces = $2::jsonb, updated_by = $3, status = 'checking', checked_at = null, error = null,
       updated_at = date_trunc('milliseconds', clock_timestamp())
     where tenant_id = $1 returning *`,
    [tenantId, unchecked(spaces), updatedBy],
  );
  return rows[0] && toConnection(rows[0]);
}

export async function getConnection(db: Queryable, tenantId: string): Promise<TenantConnection | undefined> {
  const { rows } = await db.query<Row>("select * from tenant_connections where tenant_id = $1", [tenantId]);
  return rows[0] && toConnection(rows[0]);
}

export async function getConnectionLogin(db: Queryable, tenantId: string): Promise<ConnectionLogin | undefined> {
  const { rows } = await db.query<Row>("select * from tenant_connections where tenant_id = $1", [tenantId]);
  const r = rows[0];
  return (
    r && {
      tenantId: r.tenant_id,
      clientId: r.client_id,
      sealedSecret: r.client_secret,
      tokenUrl: r.token_url,
      status: r.status,
      spaces: r.spaces.map((s) => s.space),
      updatedAt: r.updated_at,
    }
  );
}

/** "Check again": the same client and spaces, tried once more. The last results stay until the new ones. Undefined when the tenant has no client. */
export async function markConnectionChecking(db: Queryable, tenantId: string): Promise<TenantConnection | undefined> {
  const { rows } = await db.query<Row>("update tenant_connections set status = 'checking', error = null where tenant_id = $1 returning *", [tenantId]);
  return rows[0] && toConnection(rows[0]);
}

/**
 * The worker's verdict: each space's result, or why it couldn't log in at all
 * (then every space is back to unchecked). Connected when at least one space
 * is readable. Ignored (returns false) when someone changed the client or its
 * spaces, or removed it, in the meantime: that one gets its own check.
 */
export async function recordConnectionCheck(
  db: Queryable,
  login: Pick<ConnectionLogin, "tenantId" | "updatedAt" | "spaces">,
  result: { spaces: ConnectionSpace[] } | { error: string },
): Promise<boolean> {
  const [status, error, spaces] =
    "error" in result ? ["failed", result.error, unchecked(login.spaces)] : [result.spaces.some((s) => s.readable) ? "connected" : "failed", null, JSON.stringify(result.spaces)];
  const { rows } = await db.query(
    `update tenant_connections set status = $3, checked_at = now(), error = $4, spaces = $5::jsonb
     where tenant_id = $1 and updated_at = $2 returning tenant_id`,
    [login.tenantId, login.updatedAt, status, error, spaces],
  );
  return rows.length > 0;
}

export async function deleteConnection(db: Queryable, tenantId: string): Promise<boolean> {
  const { rows } = await db.query("delete from tenant_connections where tenant_id = $1 returning tenant_id", [tenantId]);
  return rows.length > 0;
}
