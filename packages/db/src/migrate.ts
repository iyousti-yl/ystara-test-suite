import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

/**
 * Schema changes are numbered SQL files in packages/db/migrations, applied in
 * name order, each once, each in its own transaction. Applied files are
 * recorded in `schema_migrations`. Never edit a migration that has been
 * applied somewhere; add a new file instead.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Applies the migrations that haven't run yet and returns their file names.
 * Refuses a database that already holds other tables but has never been
 * migrated: that is someone else's database (e.g. another Postgres on the port).
 */
export async function migrate(db: Db): Promise<string[]> {
  if (!(await hasMigrationTable(db))) {
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
    if (rows[0].n > 0) {
      throw new Error(
        `The database at ${db.where} is not Ystara's: it has ${rows[0].n} tables but no schema_migrations. ` +
          "Check DATABASE_URL or YSTARA_DB_PORT (another Postgres may be using that port).",
      );
    }
  }
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = await appliedMigrations(db);
  const files = await migrationFiles();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}

/**
 * Stops a program that reached the wrong database, or Ystara's before its
 * migrations ran, before it reads or writes anything. The API, the worker and
 * the import tool call it at startup.
 */
export async function assertYstaraDatabase(db: Db): Promise<void> {
  if (!(await hasMigrationTable(db))) {
    throw new Error(
      `The database at ${db.where} is not a Ystara database (no schema_migrations table). ` +
        "Run `npm run db:migrate` (or `docker compose up -d`), or check DATABASE_URL or YSTARA_DB_PORT.",
    );
  }
  const done = await appliedMigrations(db);
  const pending = (await migrationFiles()).filter((f) => !done.has(f));
  if (pending.length > 0) throw new Error(`The database at ${db.where} needs migrations ${pending.join(", ")}. Run \`npm run db:migrate\`.`);
}

/** Also the first query a program sends, so a connection error here says which database it tried. */
async function hasMigrationTable(db: Db): Promise<boolean> {
  try {
    const { rows } = await db.query<{ present: boolean }>("select to_regclass('public.schema_migrations') is not null as present");
    return rows[0].present;
  } catch (e) {
    // Node's AggregateError (localhost tried over IPv4 and IPv6) has an empty message but a code.
    const reason = (e as Error).message || (e as { code?: string }).code || String(e);
    throw new Error(`Could not use the database at ${db.where}: ${reason}. Check DATABASE_URL or YSTARA_DB_PORT.`, { cause: e });
  }
}

async function appliedMigrations(db: Db): Promise<Set<string>> {
  return new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
}
