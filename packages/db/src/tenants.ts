import type { Tenant } from "@ystara/shared";
import type { Queryable } from "./db.js";

/**
 * A customer's Datasphere tenant. It belongs to one account (migration 003);
 * names are unique within the account. Credentials come with the connection
 * wizard; until then the worker uses the CLI's own login.
 */
export type { Tenant };

interface Row {
  id: string;
  account_id: string;
  name: string;
  host: string | null;
  created_at: Date;
}

const toTenant = (r: Row): Tenant => ({ id: r.id, accountId: r.account_id, name: r.name, host: r.host, createdAt: r.created_at });

export async function createTenant(db: Queryable, input: { accountId: string; name: string; host: string | null }): Promise<Tenant> {
  const { rows } = await db.query<Row>("insert into tenants (account_id, name, host) values ($1, $2, $3) returning *", [input.accountId, input.name, input.host]);
  return toTenant(rows[0]);
}

export async function listTenants(db: Queryable, accountId: string): Promise<Tenant[]> {
  return (await db.query<Row>("select * from tenants where account_id = $1 order by name", [accountId])).rows.map(toTenant);
}

/** Any account's tenant: callers check `accountId` before showing it. */
export async function getTenant(db: Queryable, id: string): Promise<Tenant | undefined> {
  const { rows } = await db.query<Row>("select * from tenants where id = $1", [id]);
  return rows[0] && toTenant(rows[0]);
}

export async function findTenantByName(db: Queryable, accountId: string, name: string): Promise<Tenant | undefined> {
  const { rows } = await db.query<Row>("select * from tenants where account_id = $1 and name = $2", [accountId, name]);
  return rows[0] && toTenant(rows[0]);
}
