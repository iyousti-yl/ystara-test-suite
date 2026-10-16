import type { ConnectionStatus, TenantConnection } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * Each tenant's technical OAuth client (migration 005; the lifecycle is on
 * TenantConnection in @ystara/shared). The secret arrives here already sealed
 * with MASTER_KEY: this package never sees it in clear text, and only
 * `getConnectionLogin` (for the worker) reads it back.
 */
export type { ConnectionStatus, TenantConnection };

/** What the worker needs to log in. `clientSecret` is still sealed. */
export interface ConnectionLogin {
  tenantId: string;
  clientId: string;
  sealedSecret: string;
  tokenUrl: string;
  status: ConnectionStatus;
  /** Which client this is: a check records its result only if the client hasn't changed since. */
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
  spaces: string[];
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

/**
 * Saves a new or changed client. It starts as "checking", with no spaces, until the worker has tried it.
 * `updated_at` is kept to the millisecond, the precision a JavaScript Date carries back in `recordConnectionCheck`.
 */
export async function setConnection(
  db: Queryable,
  input: { tenantId: string; clientId: string; sealedSecret: string; tokenUrl: string; updatedBy: string | null },
): Promise<TenantConnection> {
  const { rows } = await db.query<Row>(
    `insert into tenant_connections (tenant_id, client_id, client_secret, token_url, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, date_trunc('milliseconds', clock_timestamp()))
     on conflict (tenant_id) do update set client_id = $2, client_secret = $3, token_url = $4, updated_by = $5,
       status = 'checking', checked_at = null, error = null, spaces = '{}', updated_at = excluded.updated_at
     returning *`,
    [input.tenantId, input.clientId, input.sealedSecret, input.tokenUrl, input.updatedBy],
  );
  return toConnection(rows[0]);
}

export async function getConnection(db: Queryable, tenantId: string): Promise<TenantConnection | undefined> {
  const { rows } = await db.query<Row>("select * from tenant_connections where tenant_id = $1", [tenantId]);
  return rows[0] && toConnection(rows[0]);
}

export async function getConnectionLogin(db: Queryable, tenantId: string): Promise<ConnectionLogin | undefined> {
  const { rows } = await db.query<Row>("select * from tenant_connections where tenant_id = $1", [tenantId]);
  const r = rows[0];
  return r && { tenantId: r.tenant_id, clientId: r.client_id, sealedSecret: r.client_secret, tokenUrl: r.token_url, status: r.status, updatedAt: r.updated_at };
}

/** "Check again": the same client, tried once more. Undefined when the tenant has no client. */
export async function markConnectionChecking(db: Queryable, tenantId: string): Promise<TenantConnection | undefined> {
  const { rows } = await db.query<Row>("update tenant_connections set status = 'checking', error = null where tenant_id = $1 returning *", [tenantId]);
  return rows[0] && toConnection(rows[0]);
}

/**
 * The worker's verdict on the client it checked. Ignored (returns false) when
 * someone changed or removed the client in the meantime: that one gets its own check.
 */
export async function recordConnectionCheck(
  db: Queryable,
  login: Pick<ConnectionLogin, "tenantId" | "updatedAt">,
  result: { ok: true; spaces: string[] } | { ok: false; error: string },
): Promise<boolean> {
  const { rows } = await db.query(
    `update tenant_connections set status = $3, checked_at = now(), error = $4, spaces = coalesce($5, spaces)
     where tenant_id = $1 and updated_at = $2 returning tenant_id`,
    result.ok
      ? [login.tenantId, login.updatedAt, "connected", null, result.spaces]
      : [login.tenantId, login.updatedAt, "failed", result.error, null],
  );
  return rows.length > 0;
}

export async function deleteConnection(db: Queryable, tenantId: string): Promise<boolean> {
  const { rows } = await db.query("delete from tenant_connections where tenant_id = $1 returning tenant_id", [tenantId]);
  return rows.length > 0;
}
