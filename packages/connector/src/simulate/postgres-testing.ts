import { PGlite } from "@electric-sql/pglite";
import type { Row } from "../sql.js";
import type { Fragment } from "./fragment.js";

/**
 * For tests: runs composed queries of the synthetic pipelines on PostgreSQL
 * (PGlite, in memory), with a one-row `dummy` table, so a test can check
 * what a query returns and not only how it reads.
 */
export async function withPostgres<T>(run: (select: (f: Fragment) => Promise<Row[]>) => Promise<T>): Promise<T> {
  const pg = new PGlite();
  try {
    await pg.exec('create table dummy ("DUMMY" varchar(1)); insert into dummy values (\'X\')');
    return await run(async (f) => {
      const q = toPostgres(f);
      return (await pg.query<Row>(q.sql, q.params)).rows;
    });
  } finally {
    await pg.close();
  }
}

/** SAP HANA SQL of the synthetic pipelines as PostgreSQL reads it: numbered placeholders, VARCHAR for NVARCHAR. */
export function toPostgres(f: Fragment): Fragment {
  let n = 0;
  return { sql: f.sql.replace(/\?/g, () => `$${++n}`).replace(/NVARCHAR\(/g, "VARCHAR("), params: f.params };
}
