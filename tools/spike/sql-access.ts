/**
 * Spike for phase 2: can a database user of a space read it with SQL, so
 * snapshot tests can measure its views and tables?
 *
 * Strictly read-only: every statement is one SELECT that passes the
 * connector's read-only guard (assertSelectOnly), and nothing is created or
 * changed in the tenant. It prints names, counts and timings, never a value
 * from the data, so its output can be shared.
 *
 * Before running it, in the tenant (a space administrator does this once):
 *   1. Space Management > the space > Database Access > Database Users >
 *      Create. Tick "Enable Read Access (SQL)" and leave write access off.
 *   2. The user's details show its name (SPACE#SUFFIX), the host and the port
 *      (443), and let you ask for a password.
 * Then put in .env.local (never in .env or a committed file):
 *   DSP_DB_HOST, DSP_DB_USER, DSP_DB_PASSWORD (DSP_DB_PORT if not 443), and
 *   DSP_SPACE: the space ID, which is also its schema. When it lists several,
 *   the spike reads the one the user belongs to (the part of its name before #).
 * Put DSP_DB_USER and DSP_DB_PASSWORD in single quotes (double quotes for a
 * password with a ' in it):
 *   DSP_DB_USER='SPACE#SUFFIX'
 *   DSP_DB_PASSWORD='...'
 * Unquoted, a # starts a comment and the rest of the value is lost. The spike
 * refuses such a value before it signs in, because repeated failed sign-ins
 * can lock the user.
 * Optionally DSP_SQL_OBJECT: the view or table to measure (by default, the
 * first view it can read). Then run `npm run spike:sql`.
 *
 * What it finds out:
 *   - which privileges the user has, and that none of them can change the
 *     space's schema (a user with write access fails the spike: Ystara wants
 *     one that can only read);
 *   - how many views and tables of the space the user sees, and whether a
 *     sample of each can be read (SELECT TOP 1 1, no data);
 *   - how long one object takes to measure: the row count alone, then all
 *     snapshot metrics in one pass (per column: non-null and distinct counts,
 *     min and max hashed in the database with a salt, and a sum for numbers).
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metricsQuery, quoteIdentifier, SqlReader } from "@ystara/connector";
import { loadLocalEnv } from "@ystara/shared/env";
import { databaseUserFromEnv, requiredEnv } from "./database-user.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const NEEDS = "This spike needs DSP_DB_HOST, DSP_DB_USER, DSP_DB_PASSWORD and DSP_SPACE.";
const db = databaseUserFromEnv(root, NEEDS);
// The space the user belongs to, when DSP_SPACE lists it; else the first one.
const spaces = requiredEnv("DSP_SPACE", NEEDS).split(",").map((s) => s.trim()).filter(Boolean);
const own = db.user.split("#")[0];
const space = spaces.includes(own) ? own : spaces[0];
const target = process.env.DSP_SQL_OBJECT?.trim();
/** Privileges that only read. Anything else on the space's schema could change it. */
const READ_PRIVILEGES = new Set(["SELECT", "SELECT METADATA", "SELECT CDS METADATA"]);
const SAMPLE = 10;
let failures = 0;

/** Runs one step and prints how it went and how long it took, like the technical-client spike. */
async function step<T>(name: string, run: () => Promise<T>, describe: (result: T) => string, opts: { optional?: string } = {}): Promise<T | undefined> {
  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  try {
    const result = await run();
    console.log(`ok    ${name} (${took()}): ${describe(result)}`);
    return result;
  } catch (e) {
    const reason = firstLine(e);
    if (opts.optional) console.log(`warn  ${name} (${took()}): ${opts.optional}\n      ${reason}`);
    else {
      failures++;
      console.log(`FAIL  ${name} (${took()}): ${reason}`);
    }
    return undefined;
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0].split(db.password).join("<password>");
}

console.log(`Database user ${db.user} on ${db.host}:${db.port}, space ${space}\n`);
const sql = await step("connect", () => SqlReader.connect(db), () => "connected (TLS)");
try {
  if (sql) {
    const me = await step(
      "who am I",
      async () => (await sql.select<{ user: string; schema: string }>('select current_user as "user", current_schema as "schema" from dummy'))[0],
      (r) => `user ${r.user}, default schema ${r.schema}`,
    );

    if (me) {
      await step(
        "privileges",
        async () => {
          const rows = await sql.select<{ privilege: string; schema: string | null }>(
            'select privilege as "privilege", schema_name as "schema" from sys.effective_privileges where user_name = ?',
            [me.user],
          );
          const bySchema = new Map<string, Map<string, number>>();
          for (const r of rows) {
            const schema = r.schema ?? "(system)";
            const privileges = bySchema.get(schema) ?? new Map<string, number>();
            privileges.set(r.privilege, (privileges.get(r.privilege) ?? 0) + 1);
            bySchema.set(schema, privileges);
          }
          for (const [schema, privileges] of bySchema) {
            console.log(`      ${schema}: ${[...privileges].map(([p, n]) => (n > 1 ? `${p} (${n} objects)` : p)).join(", ")}`);
          }
          const writes = [...(bySchema.get(space)?.keys() ?? [])].filter((p) => !READ_PRIVILEGES.has(p));
          if (writes.length) throw new Error(`the user can change schema ${space} (${writes.join(", ")}). Create one with read access only.`);
          return bySchema.get(space);
        },
        (onSpace) => (onSpace ? `on ${space} only reads` : `none directly on ${space} (read access may come through roles; the next steps show what it can read)`),
        { optional: "can't read its own privileges, so it can't tell whether it could write" },
      );
    }

    const objects = await step(
      `objects in ${space}`,
      () => sql.select<{ name: string; type: string }>(
        "select object_name as \"name\", object_type as \"type\" from sys.objects where schema_name = ? and object_type in ('VIEW', 'TABLE') order by object_name",
        [space],
      ),
      (list) => `${list.filter((o) => o.type === "VIEW").length} views, ${list.filter((o) => o.type === "TABLE").length} tables visible`,
    );

    const readable: { name: string; type: string }[] = [];
    for (const type of ["VIEW", "TABLE"]) {
      const sample = (objects ?? []).filter((o) => o.type === type).slice(0, SAMPLE);
      if (!sample.length) continue;
      await step(
        `read a sample of ${type.toLowerCase()}s`,
        async () => {
          const refused: string[] = [];
          for (const o of sample) {
            try {
              await sql.select(`select top 1 1 as "one" from ${quoteIdentifier(space)}.${quoteIdentifier(o.name)}`);
              readable.push(o);
            } catch (e) {
              refused.push(`${o.name}: ${firstLine(e)}`);
            }
          }
          if (refused.length === sample.length) throw new Error(`none of ${sample.length} readable. First refusal: ${refused[0]}`);
          return refused;
        },
        (refused) => `${sample.length - refused.length} of ${sample.length} readable${refused.length ? `. First refusal: ${refused[0]}` : ""}`,
      );
    }

    const chosen = target ? (objects ?? []).find((o) => o.name === target) : (readable.find((o) => o.type === "VIEW") ?? readable[0]);
    if (target && !chosen) {
      failures++;
      console.log(`FAIL  measure ${target}: the user doesn't see it in ${space}`);
    }
    if (chosen) {
      const columnsView = chosen.type === "VIEW" ? "sys.view_columns" : "sys.table_columns";
      const nameColumn = chosen.type === "VIEW" ? "view_name" : "table_name";
      const columns = await step(
        `columns of ${chosen.name}`,
        () => sql.select<{ name: string; dataType: string; scale: number | null }>(
          `select column_name as "name", data_type_name as "dataType", scale as "scale" from ${columnsView} where schema_name = ? and ${nameColumn} = ? order by position`,
          [space, chosen.name],
        ),
        (list) => `${list.length} columns`,
      );
      await step(
        `row count of ${chosen.name}`,
        async () => (await sql.select<{ rows: number }>(`select count(*) as "rows" from ${quoteIdentifier(space)}.${quoteIdentifier(chosen.name)}`))[0].rows,
        (rows) => `${rows} rows`,
      );
      if (columns?.length) {
        // A throwaway salt: the spike times the query and prints none of its results.
        const query = metricsQuery(space, chosen.name, columns, randomBytes(32).toString("hex"));
        const measures = query.columns.reduce((n, c) => n + c.metrics.length, 1);
        const floating = query.columns.filter((c) => c.sum?.floating).length;
        await step(
          `all snapshot metrics of ${chosen.name}`,
          () => sql.select(query.sql),
          () => `${measures} measures over ${columns.length} columns in one pass (${floating} floating column(s) summed at a fixed scale)`,
        );
      }
    }
  }

  console.log(
    failures
      ? `\nVerdict: database user ${db.user} can't be used for snapshots of ${space} yet. The failures above say why.`
      : `\nVerdict: database user ${db.user} can read ${space} with SQL, and only read it.`,
  );
  if (failures) process.exitCode = 1;
} finally {
  await sql?.close();
}
