import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";

/**
 * A fresh, migrated, in-memory Postgres for tests (PGlite: real Postgres
 * compiled to WebAssembly). No Docker or database server needed, on Windows too.
 * Import it from "@ystara/db/testing" in test files only.
 */
export async function createTestDb(opts: { migrated?: boolean } = {}): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    where: "the in-memory test database",
    query: (text, params) => pg.query(text, params),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: (text, params) => tx.query(text, params),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => pg.close(),
  };
  if (opts.migrated ?? true) await migrate(db);
  return db;
}
