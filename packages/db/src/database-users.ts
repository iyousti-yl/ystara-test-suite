import type { SpaceDatabaseUser } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * The database users snapshots read each space with (migration 006; the
 * lifecycle is on SpaceDatabaseUser in @ystara/shared). As with the technical
 * client, the password arrives here already sealed with MASTER_KEY, and only
 * `getDatabaseUserLogin` (for the worker) reads it back.
 */
export type { SpaceDatabaseUser };

/** What the worker needs to sign in. `sealedPassword` is still sealed. */
export interface DatabaseUserLogin {
  tenantId: string;
  space: string;
  host: string;
  user: string;
  sealedPassword: string;
  /** Which user and password this is: a check records its result only if neither has changed since. */
  updatedAt: Date;
}

interface Row {
  tenant_id: string;
  space: string;
  host: string;
  user_name: string;
  password: string;
  status: SpaceDatabaseUser["status"];
  checked_at: Date | null;
  error: string | null;
  visible: SpaceDatabaseUser["visible"];
  updated_at: Date;
}

const toUser = (r: Row): SpaceDatabaseUser => ({
  tenantId: r.tenant_id,
  space: r.space,
  host: r.host,
  user: r.user_name,
  status: r.status,
  checkedAt: r.checked_at,
  error: r.error,
  visible: r.visible,
  updatedAt: r.updated_at,
});

/**
 * Saves a new or changed database user of a space, to be checked: "checking",
 * and what an earlier user saw is forgotten. `updated_at` is kept to the
 * millisecond, the precision a JavaScript Date carries back in `recordDatabaseCheck`.
 */
export async function setDatabaseUser(
  db: Queryable,
  input: { tenantId: string; space: string; host: string; user: string; sealedPassword: string; updatedBy: string | null },
): Promise<SpaceDatabaseUser> {
  const { rows } = await db.query<Row>(
    `insert into space_database_users (tenant_id, space, host, user_name, password, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, date_trunc('milliseconds', clock_timestamp()))
     on conflict (tenant_id, space) do update set host = $3, user_name = $4, password = $5, updated_by = $6,
       status = 'checking', checked_at = null, error = null, visible = null, updated_at = excluded.updated_at
     returning *`,
    [input.tenantId, input.space, input.host, input.user, input.sealedPassword, input.updatedBy],
  );
  return toUser(rows[0]);
}

/** The tenant's database users, by space. */
export async function listDatabaseUsers(db: Queryable, tenantId: string): Promise<SpaceDatabaseUser[]> {
  const { rows } = await db.query<Row>("select * from space_database_users where tenant_id = $1 order by space", [tenantId]);
  return rows.map(toUser);
}

export async function getDatabaseUser(db: Queryable, tenantId: string, space: string): Promise<SpaceDatabaseUser | undefined> {
  const { rows } = await db.query<Row>("select * from space_database_users where tenant_id = $1 and space = $2", [tenantId, space]);
  return rows[0] && toUser(rows[0]);
}

export async function getDatabaseUserLogin(db: Queryable, tenantId: string, space: string): Promise<DatabaseUserLogin | undefined> {
  const { rows } = await db.query<Row>("select * from space_database_users where tenant_id = $1 and space = $2", [tenantId, space]);
  const r = rows[0];
  return r && { tenantId: r.tenant_id, space: r.space, host: r.host, user: r.user_name, sealedPassword: r.password, updatedAt: r.updated_at };
}

/** "Check again": the same user and password, tried once more. What it saw last time stays until the new result. */
export async function markDatabaseUserChecking(db: Queryable, tenantId: string, space: string): Promise<SpaceDatabaseUser | undefined> {
  const { rows } = await db.query<Row>(
    "update space_database_users set status = 'checking', error = null where tenant_id = $1 and space = $2 returning *",
    [tenantId, space],
  );
  return rows[0] && toUser(rows[0]);
}

/**
 * The worker's verdict: what the user sees in its space, or why the check
 * failed (then that list is gone too: what it saw can't be trusted any more).
 * Ignored (returns false) when someone changed or removed the user meanwhile.
 */
export async function recordDatabaseCheck(
  db: Queryable,
  login: Pick<DatabaseUserLogin, "tenantId" | "space" | "updatedAt">,
  result: { visible: NonNullable<SpaceDatabaseUser["visible"]> } | { error: string },
): Promise<boolean> {
  const [status, error, visible] = "error" in result ? ["failed", result.error, null] : ["connected", null, JSON.stringify(result.visible)];
  const { rows } = await db.query(
    `update space_database_users set status = $4, checked_at = now(), error = $5, visible = $6::jsonb
     where tenant_id = $1 and space = $2 and updated_at = $3 returning space`,
    [login.tenantId, login.space, login.updatedAt, status, error, visible],
  );
  return rows.length > 0;
}

export async function deleteDatabaseUser(db: Queryable, tenantId: string, space: string): Promise<boolean> {
  const { rows } = await db.query("delete from space_database_users where tenant_id = $1 and space = $2 returning space", [tenantId, space]);
  return rows.length > 0;
}
