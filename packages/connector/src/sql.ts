/**
 * Reads a Datasphere space with SQL, through a database user of the space
 * (Space Management > Database Access), for snapshot tests. Read-only: every
 * statement goes through `assertSelectOnly` (readonly.ts) before it is sent,
 * and values are bound as `?` parameters, never written into the SQL.
 *
 * The driver is hdb, SAP's open-source JavaScript client for SAP HANA
 * (Apache-2.0, no native build). Datasphere's database takes TLS on port 443.
 */
import hdb from "hdb";
import { DATABASE_HOST_HINT, databaseUserProblem, isDatabaseHost } from "@ystara/shared";
import { assertSelectOnly } from "./readonly.js";

export interface DatabaseUser {
  /** The host shown with the database user, e.g. your-tenant.hana.prod-eu10.hanacloud.ondemand.com, or hna1 in place of hana (isDatabaseHost). */
  host: string;
  port?: number;
  /** SPACE#SUFFIX */
  user: string;
  password: string;
}

export type Row = Record<string, unknown>;

export class SqlReader {
  private constructor(
    private readonly client: ReturnType<typeof hdb.createClient>,
    private readonly password: string,
  ) {}

  /** Signs in. Only on SAP HANA Cloud, where Datasphere's database runs: the password goes nowhere else. */
  static async connect(db: DatabaseUser): Promise<SqlReader> {
    if (!isDatabaseHost(db.host)) throw new Error(`${db.host} is not a Datasphere database host, so the password is not sent there. ${DATABASE_HOST_HINT}.`);
    const client = hdb.createClient({ host: db.host, port: db.port ?? 443, user: db.user, password: db.password, useTLS: true });
    // A dropped connection is reported on the next call; without a listener it would end the process.
    client.on("error", () => undefined);
    const reader = new SqlReader(client, db.password);
    await reader.call<void>((cb) => client.connect(cb));
    return reader;
  }

  /** Runs one SELECT with `params` bound to its `?` placeholders. */
  async select<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    assertSelectOnly(sql);
    if (!params.length) return (await this.call<unknown>((cb) => this.client.exec(sql, cb))) as T[];
    const statement = await this.call<{ exec(p: unknown[], cb: (e: Error | null, r: unknown) => void): void; drop(cb: (e: Error | null) => void): void }>(
      (cb) => this.client.prepare(sql, cb),
    );
    try {
      return (await this.call<unknown>((cb) => statement.exec(params, cb))) as T[];
    } finally {
      statement.drop(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.call<void>((cb) => this.client.disconnect(cb)).catch(() => undefined);
    this.client.close();
  }

  /** A callback call as a promise. A copy of the password in an error message is cut out. */
  private call<T>(run: (cb: (err: Error | null, result: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) =>
      run((err, result) => {
        if (!err) return resolve(result);
        if (this.password && err.message.includes(this.password)) err.message = err.message.split(this.password).join("<password>");
        reject(err);
      }),
    );
  }
}

/** What a database user saw in its space's schema: with read access, the views exposed for consumption. */
export interface DatabaseUserCheck {
  visible: { name: string; type: "VIEW" | "TABLE" }[];
}

/** Privileges that only read. Any other on the space's schema could change it. */
const READ_PRIVILEGES = new Set(["SELECT", "SELECT METADATA", "SELECT CDS METADATA"]);

/**
 * The check of a space's database user before snapshots use it, as
 * `npm run spike:sql` does: sign in, make sure the user can't change the
 * space's schema (Ystara wants one that can only read), and list the views and
 * tables it sees there. Throws a sentence that says what went wrong and what
 * to do, without the password.
 */
export async function checkDatabaseUser(user: DatabaseUser, space: string): Promise<DatabaseUserCheck> {
  const problem = databaseUserProblem(user.user);
  if (problem) throw new Error(`The user name ${user.user} can't be right: ${problem}. Nothing was sent to the tenant.`);
  const sql = await failsWith("Signing in failed. Check the user name and password (repeated failed sign-ins can lock the user)", () => SqlReader.connect(user));
  try {
    const privileges = await failsWith("The user can't read its own privileges, so Ystara can't tell whether it could change the space", async () => {
      const [me] = await sql.select<{ user: string }>('select current_user as "user" from dummy');
      return sql.select<{ privilege: string; schema: string | null }>(
        'select privilege as "privilege", schema_name as "schema" from sys.effective_privileges where user_name = ?',
        [me.user],
      );
    });
    const writes = [...new Set(privileges.filter((p) => p.schema === space && !READ_PRIVILEGES.has(p.privilege)).map((p) => p.privilege))];
    if (writes.length) {
      throw new Error(`This user can change the space's schema (${writes.join(", ")}). Ystara only reads: create a database user with read access only, and leave write access off.`);
    }
    const visible = await failsWith("Listing what the user sees in the space failed", () =>
      sql.select<{ name: string; type: "VIEW" | "TABLE" }>(
        "select object_name as \"name\", object_type as \"type\" from sys.objects where schema_name = ? and object_type in ('VIEW', 'TABLE') order by object_name",
        [space],
      ),
    );
    return { visible };
  } finally {
    await sql.close();
  }
}

/** Runs `run`; if it fails, says which step failed, then the database's own first line. */
async function failsWith<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`${what}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
}

/** A name in double quotes, as SQL wants it for case and special characters: SALES -> "SALES", A"B -> "A""B". */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** What a snapshot measures on a column, depending on its type. */
export type ColumnMetric = "nonNull" | "distinct" | "min" | "max" | "sum";

const NUMERIC = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "DECIMAL", "SMALLDECIMAL", "REAL", "DOUBLE", "FLOAT"]);
const ORDERED = new Set([...NUMERIC, "DATE", "TIME", "SECONDDATE", "TIMESTAMP", "VARCHAR", "NVARCHAR", "ALPHANUM", "SHORTTEXT", "CHAR", "NCHAR"]);
/** Large objects and shapes: HANA can count them but not compare them. */
const UNCOMPARABLE = new Set(["BLOB", "CLOB", "NCLOB", "TEXT", "BINTEXT", "ST_GEOMETRY", "ST_POINT"]);

/** The metrics for a column of `dataType` (HANA's DATA_TYPE_NAME). */
export function columnMetrics(dataType: string): ColumnMetric[] {
  const type = dataType.toUpperCase();
  if (UNCOMPARABLE.has(type)) return ["nonNull"];
  const metrics: ColumnMetric[] = ["nonNull", "distinct"];
  if (ORDERED.has(type)) metrics.push("min", "max");
  if (NUMERIC.has(type)) metrics.push("sum");
  return metrics;
}

const AGGREGATE: Record<ColumnMetric, (column: string) => string> = {
  nonNull: (c) => `count(${c})`,
  distinct: (c) => `count(distinct ${c})`,
  min: (c) => `min(${c})`,
  max: (c) => `max(${c})`,
  sum: (c) => `sum(${c})`,
};

/**
 * One SELECT that measures a whole view or table in a single pass: its row
 * count, and per column the metrics of its type. Each result is named
 * c<column index>_<metric> (and "rows"), so any column name is safe.
 */
export function metricsQuery(schema: string, object: string, columns: { name: string; dataType: string }[]) {
  const measured = columns.map((c, i) => ({ ...c, index: i, metrics: columnMetrics(c.dataType) }));
  const parts = ['count(*) as "rows"'];
  for (const c of measured) for (const m of c.metrics) parts.push(`${AGGREGATE[m](quoteIdentifier(c.name))} as "c${c.index}_${m}"`);
  return { sql: `select ${parts.join(", ")} from ${quoteIdentifier(schema)}.${quoteIdentifier(object)}`, columns: measured };
}
