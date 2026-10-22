import { quoteIdentifier } from "../sql.js";
import { concat, fragment, SimulationStop, type Fragment } from "./fragment.js";

/** A column of a table as a simulation needs it: its name and SAP HANA type. */
export interface FixtureColumn {
  name: string;
  /** e.g. NVARCHAR(40), DECIMAL(15, 2), DATE */
  type: string;
  /** Part of the table's key, when its definition says so. */
  key?: boolean;
}

/** A fixture value, as a scenario writes it. */
export type Cell = string | number | boolean | null;

/** A CSN element: a column of a table or view. */
interface CsnElement {
  type?: string;
  length?: number;
  precision?: number;
  scale?: number | string;
  virtual?: boolean;
  key?: boolean;
}

const count = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : fallback);

/** CDS types (the `type` of a CSN element) and the SAP HANA type a fixture value is cast to. */
const CDS_TYPES: Record<string, (e: CsnElement) => string> = {
  "cds.String": (e) => `NVARCHAR(${count(e.length, 5000)})`,
  "cds.LargeString": () => "NCLOB",
  "cds.Boolean": () => "BOOLEAN",
  "cds.UInt8": () => "TINYINT",
  "cds.Int16": () => "SMALLINT",
  "cds.Int32": () => "INTEGER",
  "cds.Integer": () => "INTEGER",
  "cds.Int64": () => "BIGINT",
  "cds.Integer64": () => "BIGINT",
  "cds.Decimal": (e) => (Number.isInteger(e.precision) ? `DECIMAL(${e.precision}, ${Number.isInteger(e.scale) ? e.scale : 0})` : "DECIMAL"),
  "cds.DecimalFloat": () => "DECIMAL",
  "cds.Double": () => "DOUBLE",
  "cds.Date": () => "DATE",
  "cds.Time": () => "TIME",
  "cds.DateTime": () => "SECONDDATE",
  "cds.Timestamp": () => "TIMESTAMP",
  "cds.UUID": () => "NVARCHAR(36)",
  "cds.Binary": (e) => `VARBINARY(${count(e.length, 5000)})`,
  "cds.LargeBinary": () => "BLOB",
  "cds.hana.NCHAR": (e) => `NCHAR(${count(e.length, 1)})`,
  "cds.hana.CHAR": (e) => `CHAR(${count(e.length, 1)})`,
  "cds.hana.VARCHAR": (e) => `VARCHAR(${count(e.length, 5000)})`,
  "cds.hana.TINYINT": () => "TINYINT",
  "cds.hana.SMALLINT": () => "SMALLINT",
  "cds.hana.SMALLDECIMAL": () => "SMALLDECIMAL",
  "cds.hana.REAL": () => "REAL",
  "cds.hana.BINARY": (e) => `BINARY(${count(e.length, 1)})`,
};

/** The SAP HANA type of a CSN element; undefined for a type this table doesn't know. */
export function hanaType(element: CsnElement): string | undefined {
  return element.type ? CDS_TYPES[element.type]?.(element) : undefined;
}

/**
 * The columns of a table from its CSN definition (`definitions.<name>.elements`).
 * Associations and virtual elements are not columns. A column of a type this
 * spike doesn't know becomes NVARCHAR(5000) and is listed in `unknownTypes`.
 */
export function tableColumns(definition: unknown, name: string): { columns: FixtureColumn[]; unknownTypes: string[] } {
  const entity = (definition as { definitions?: Record<string, { elements?: Record<string, CsnElement> }> } | undefined)?.definitions?.[name];
  if (!entity?.elements) throw new SimulationStop(`the definition of ${name} lists no columns`);
  const columns: FixtureColumn[] = [];
  const unknownTypes: string[] = [];
  for (const [column, element] of Object.entries(entity.elements)) {
    if (element.virtual || element.type === "cds.Association" || element.type === "cds.Composition") continue;
    const type = hanaType(element);
    if (!type) unknownTypes.push(`${column} (${element.type ?? "no type"})`);
    columns.push({ name: column, type: type ?? "NVARCHAR(5000)", ...(element.key ? { key: true } : {}) });
  }
  if (!columns.length) throw new SimulationStop(`the definition of ${name} lists no columns`);
  return { columns, unknownTypes };
}

/**
 * Made-up rows for a table: row i (from 1) holds i in every column, as text,
 * a number, a date or a time of its type. Every table gets the same keys
 * 1, 2, 3, so joins between generated fixtures find each other. Filters on
 * other values will often keep nothing: a scenario gives real-looking rows.
 */
export function sampleRows(columns: FixtureColumn[], rows = 3): Record<string, Cell>[] {
  return Array.from({ length: Math.min(rows, 9) }, (_, index) => {
    const i = index + 1;
    return Object.fromEntries(columns.map((c) => [c.name, sampleValue(c.type, i)]));
  });
}

function sampleValue(type: string, i: number): Cell {
  const base = type.replace(/\(.*$/, "");
  if (["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "DECIMAL", "SMALLDECIMAL", "REAL", "DOUBLE"].includes(base)) return i;
  if (base === "BOOLEAN") return i % 2 === 1;
  if (base === "DATE") return `2026-01-0${i}`;
  if (base === "TIME") return `0${i}:00:00`;
  if (base === "SECONDDATE" || base === "TIMESTAMP") return `2026-01-0${i} 00:00:00`;
  if (base === "VARBINARY" || base === "BINARY" || base === "BLOB") return null;
  return String(i);
}

/**
 * A table's rows inlined in one SELECT that reads nothing but DUMMY:
 *
 *   SELECT CAST(? AS NVARCHAR(40)) AS "EMP_ID", ... FROM DUMMY
 *   UNION ALL SELECT CAST(? AS NVARCHAR(40)) AS "EMP_ID", ... FROM DUMMY
 *
 * Every value is bound to a `?`; a column a row leaves out is NULL. With no
 * rows, the SELECT has the columns and returns nothing.
 */
export function fixtureQuery(table: string, columns: FixtureColumn[], rows: Record<string, Cell>[]): Fragment {
  const names = new Set(columns.map((c) => c.name));
  for (const row of rows) {
    const extra = Object.keys(row).filter((k) => !names.has(k));
    if (extra.length) throw new SimulationStop(`the test rows for ${table} have columns the table doesn't have: ${extra.join(", ")}`);
  }
  if (!rows.length) return fragment(`SELECT ${columns.map((c) => `CAST(NULL AS ${c.type}) AS ${quoteIdentifier(c.name)}`).join(", ")} FROM DUMMY WHERE 1 = 0`);
  const selects = rows.map((row) =>
    concat([
      "SELECT ",
      concat(
        columns.map((c) => (row[c.name] === undefined || row[c.name] === null ? `CAST(NULL AS ${c.type}) AS ${quoteIdentifier(c.name)}` : fragment(`CAST(? AS ${c.type}) AS ${quoteIdentifier(c.name)}`, [row[c.name]]))),
        ", ",
      ),
      " FROM DUMMY",
    ]),
  );
  return concat(selects, " UNION ALL ");
}
