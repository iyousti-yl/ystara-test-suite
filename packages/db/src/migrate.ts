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

/** Applies the migrations that haven't run yet and returns their file names. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

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
