import type { Queryable } from "./db.js";

/** A customer's Datasphere tenant. Credentials come with the connection wizard; until then the worker uses the CLI's own login. */
export interface Tenant {
  id: string;
  name: string;
  /** Datasphere URL. Null for a tenant that only has imported scans. */
  host: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  name: string;
  host: string | null;
  created_at: Date;
}

const toTenant = (r: Row): Tenant => ({ id: r.id, name: r.name, host: r.host, createdAt: r.created_at });

export async function createTenant(db: Queryable, input: { name: string; host: string | null }): Promise<Tenant> {
  const { rows } = await db.query<Row>("insert into tenants (name, host) values ($1, $2) returning *", [input.name, input.host]);
  return toTenant(rows[0]);
}

export async function listTenants(db: Queryable): Promise<Tenant[]> {
  return (await db.query<Row>("select * from tenants order by name")).rows.map(toTenant);
}

export async function getTenant(db: Queryable, id: string): Promise<Tenant | undefined> {
  const { rows } = await db.query<Row>("select * from tenants where id = $1", [id]);
  return rows[0] && toTenant(rows[0]);
}

export async function findTenantByName(db: Queryable, name: string): Promise<Tenant | undefined> {
  const { rows } = await db.query<Row>("select * from tenants where name = $1", [name]);
  return rows[0] && toTenant(rows[0]);
}
