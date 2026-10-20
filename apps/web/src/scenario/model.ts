import type { Assertion, ScenarioColumn } from "@ystara/shared";

/**
 * What the scenario builder edits, apart from the screen: test rows as text in
 * a grid, turned into the values a scenario keeps by each column's type, and
 * rows pasted from a spreadsheet. A cell left empty is NULL: the row leaves the
 * column out, as in a scenario file.
 */
export type Cell = string | number | boolean | null;

/** A table's or an expected result's rows as typed: one text per column name. */
export interface Grid {
  columns: ScenarioColumn[];
  rows: Record<string, string>[];
}

/** The input a column takes, from its SAP HANA type. */
export function columnKind(type: string): "number" | "boolean" | "text" {
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|DECIMAL|SMALLDECIMAL|REAL|DOUBLE|FLOAT|DECFLOAT)\b/i.test(type)) return "number";
  if (/^BOOLEAN\b/i.test(type)) return "boolean";
  return "text";
}

const BOOLEANS: Record<string, boolean> = { true: true, false: false, yes: true, no: false, "1": true, "0": false };

/**
 * What a person typed, as the value a scenario keeps: undefined when empty (NULL). A number column takes
 * a comma or a point as the decimal sign; a value a JavaScript number would round ("0.10", 20 digits) stays
 * text, which the database reads as the exact decimal. `invalid` says what the column expects instead.
 */
export function cellFromText(text: string, type: string): { cell: Cell | undefined; invalid?: string } {
  if (text === "") return { cell: undefined };
  switch (columnKind(type)) {
    case "number": {
      const t = text.trim().replace(",", ".");
      if (!/^-?\d+(\.\d+)?$/.test(t)) return { cell: text, invalid: `${type} takes a number` };
      const n = Number(t);
      return { cell: String(n) === t ? n : t };
    }
    case "boolean": {
      const b = BOOLEANS[text.trim().toLowerCase()];
      return b === undefined ? { cell: text, invalid: `${type} takes true or false` } : { cell: b };
    }
    default:
      return { cell: text };
  }
}

/** A scenario's value as the grid shows it. */
export function textFromCell(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

/**
 * A grid of `rows` over `columns`. A column the rows name that isn't one of
 * `columns` (a scenario written by hand, or a table that changed) is added at
 * the end, so nothing is dropped; the compile check says it doesn't exist.
 */
export function gridFromRows(columns: ScenarioColumn[], rows: Record<string, Cell>[]): Grid {
  const known = new Set(columns.map((c) => c.name));
  const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((name) => !known.has(name));
  return {
    columns: [...columns, ...extra.map((name) => ({ name, type: "" }))],
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, textFromCell(v)]))),
  };
}

/** The grid's rows as a scenario keeps them. A row left empty is a row of NULLs. */
export function rowsFromGrid(grid: Grid): Record<string, Cell>[] {
  return grid.rows.map((row) => {
    const out: Record<string, Cell> = {};
    for (const c of grid.columns) {
      const { cell } = cellFromText(row[c.name] ?? "", c.type);
      if (cell !== undefined) out[c.name] = cell;
    }
    return out;
  });
}

/** Text copied from a spreadsheet: one line per row, cells apart by tabs. */
export function parsePasted(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

/**
 * The grid with `pasted` written in from row `row` and column `column` on,
 * with rows added as needed. Cells past the last column are left out. When
 * the first pasted line is the columns' names (a spreadsheet's header), the
 * cells go to the columns they name, in whatever order.
 */
export function pasteInto(grid: Grid, row: number, column: number, pasted: string[][]): Grid {
  const names = grid.columns.map((c) => c.name);
  const header = pasted.length > 1 && pasted[0].every((cell) => names.includes(cell.trim())) ? pasted[0].map((cell) => cell.trim()) : undefined;
  const lines = header ? pasted.slice(1) : pasted;
  const targets = header ?? names.slice(column);
  const rows = grid.rows.map((r) => ({ ...r }));
  lines.forEach((cells, i) => {
    const at = row + i;
    while (rows.length <= at) rows.push({});
    cells.forEach((cell, j) => {
      if (targets[j] !== undefined) rows[at][targets[j]] = cell;
    });
  });
  return { ...grid, rows };
}

/** An assertion in a few words, as a run labels it (labelOf in the connector's scenario.ts). */
export function assertionLabel(a: Assertion): string {
  switch (a.type) {
    case "row_count":
      return `row_count = ${a.equals}`;
    case "no_nulls":
      return `no_nulls ${a.columns.join(", ")}`;
    case "unique":
      return `unique ${a.columns.join(", ")}`;
    case "aggregate":
      return `${a.fn}(${a.column}) = ${a.equals}${a.tolerance ? ` ± ${a.tolerance}` : ""}`;
    case "rows_equal":
      return `rows_equal on ${a.key.join(", ")} (${a.rows.length} row${a.rows.length === 1 ? "" : "s"})`;
    case "sql":
      return `sql = ${typeof a.equals === "string" ? JSON.stringify(a.equals) : String(a.equals)}`;
  }
}

/** What each kind of check verifies, for the picker. */
export const ASSERTION_KINDS: { type: Assertion["type"]; label: string; help: string }[] = [
  { type: "row_count", label: "Row count", help: "The step has exactly this many rows." },
  { type: "no_nulls", label: "No empty values", help: "These columns are never NULL." },
  { type: "unique", label: "Unique", help: "No two rows have the same values in these columns." },
  { type: "aggregate", label: "Total, minimum, maximum…", help: "A sum, min, max, average or distinct count of a column equals a value." },
  { type: "rows_equal", label: "Exact rows", help: "The step's rows are these rows, matched on key columns." },
  { type: "sql", label: "SQL", help: "A SELECT over the step's result returns this one value." },
];
