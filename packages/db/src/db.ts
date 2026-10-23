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

export interface ConnectOptions {
  /** Shown in Postgres's list of connections (pg_stat_activity), so an operator sees which program holds one. */
  application?: string;
  /**
   * The longest one statement may run before Postgres stops it. Default: no limit, for migrations and the admin
   * tools; the API and the worker set one, so a slow query can't hold a connection (and a lock) for good.
   */
  statementTimeoutMs?: number;
}

export function connect(connectionString = databaseUrl(), opts: ConnectOptions = {}): Db {
  const settings = [
    // A transaction left open (a crash between begin and commit) is ended after a minute and lets go of its locks.
    "-c idle_in_transaction_session_timeout=60000",
    ...(opts.statementTimeoutMs ? [`-c statement_timeout=${opts.statementTimeoutMs}`] : []),
  ];
  const pool = new pg.Pool({
    connectionString,
    application_name: opts.application,
    // Waiting for a free connection gives up after 10 seconds instead of forever.
    connectionTimeoutMillis: 10_000,
    options: settings.join(" "),
  });
  // A connection that drops while idle (Postgres restarted, the network blinked) is an "error" event on the pool:
  // without a listener, Node ends the whole program. The pool replaces the connection on its own.
  pool.on("error", (err) => console.error(`[db] an idle connection to ${where} failed: ${err.message}`));
  const url = new URL(connectionString);
  const where = `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <T>(text: string, params?: unknown[]) => ({ rows: (await client.query(text, params)).rows as T[] }),
    exec: async (sql: string) => {
      await client.query(sql);
    },
  });

  return {
    ...wrap(pool),
    where,
    async transaction(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("begin");
        const result = await fn(wrap(client));
        await client.query("commit");
        return result;
      } catch (e) {
        // A connection whose rollback fails is in an unknown state: it is closed rather than handed out again.
        await client.query("rollback").catch((err: Error) => (broken = err));
        throw e;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}
