import pg from "pg";
import { settingFromEnv } from "@ystara/shared/env";

/**
 * The one way the platform talks to its own Postgres database.
 *
 * Plain SQL through node-postgres, no ORM: every query is readable as written.
 * The small interface below is all the rest of the code depends on, so tests
 * can run the same queries on an in-memory Postgres (see testing.ts).
 */
export interface Queryable {
  /** One statement with $1, $2, ... parameters. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** One or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Which database this is, for error messages (host, port and name; never the password). */
  readonly where: string;
  /** Runs `fn` in one transaction: either all its writes happen, or none do. */
  transaction<R>(fn: (tx: Queryable) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** Host port of the Postgres in docker-compose.yml. Uncommon on purpose, so it doesn't meet another Postgres. */
export const DEFAULT_DB_PORT = "55432";

/** DATABASE_URL (or the file DATABASE_URL_FILE names, on a server), or the Docker Compose database on YSTARA_DB_PORT (default 55432). */
export function databaseUrl(): string {
  return settingFromEnv("DATABASE_URL") ?? `postgres://ystara:ystara@localhost:${process.env.YSTARA_DB_PORT ?? DEFAULT_DB_PORT}/ystara`;
}

export function connect(connectionString = databaseUrl()): Db {
  const pool = new pg.Pool({ connectionString });
  const url = new URL(connectionString);
  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await client.query(text, params)).rows as T[] }),
    exec: async (sql: string) => {
      await client.query(sql);
    },
  });

  return {
    ...wrap(pool),
    where: `${url.hostname}:${url.port || "5432"}${url.pathname}`,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(wrap(client));
        await client.query("commit");
        return result;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
