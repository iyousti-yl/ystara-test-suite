import type { Assertion, ScenarioColumn, ScenarioSpec } from "@ystara/shared";

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

/**
 * The columns a table's grid shows: its keys, the columns the pipeline's logic
 * reads (`used`, from the scan) and any column a row has a value in, in the
 * table's order; every column when asked, or when the scan says nothing of
 * how the columns are used. A column the grid hides is NULL in new rows.
 */
export function shownColumns(grid: Grid, all = false): ScenarioColumn[] {
  if (all || !grid.columns.some((c) => c.key || c.used)) return grid.columns;
  return grid.columns.filter((c) => c.key || c.used || !c.type || grid.rows.some((r) => (r[c.name] ?? "") !== ""));
}

/** What the pipeline does with a column, in a sentence for its header. */
export function columnNote(c: ScenarioColumn): string {
  const parts: string[] = [];
  if (c.key) parts.push("A key column.");
  if (c.keeps !== undefined) parts.push(c.keeps === null ? "A filter keeps rows where it is NULL." : `A filter keeps ${JSON.stringify(c.keeps)}.`);
  if (c.range) parts.push(`Compared with today's date, as the ${c.range} of a validity range.`);
  if (c.joined) parts.push("Joined with a column of another table.");
  if (c.used && c.keeps === undefined && !c.range && !c.joined) parts.push("Read by the pipeline's logic.");
  return parts.join(" ");
}

const lengthOf = (type: string) => Number(/\((\d+)/.exec(type)?.[1] ?? 5000);
const base = (type: string) => type.replace(/\(.*$/, "").trim().toUpperCase();

/**
 * A value to start a new row with, from what the pipeline does with the column
 * and its type, so a made-up row gets through: the value a filter keeps, a
 * validity range that includes today, and otherwise row n's number in every
 * key, joined and numeric column, so rows of different tables join row by
 * row. Other text is the column's name and the row's number, cut to its
 * length. Row n counts from 1.
 */
export function prefillText(c: ScenarioColumn, n: number, today = new Date()): string {
  const type = base(c.type);
  if (c.keeps !== undefined) return c.keeps === null ? "" : String(c.keeps);
  const compact = (type === "NVARCHAR" || type === "VARCHAR" || type === "NCHAR" || type === "CHAR") && lengthOf(c.type) === 8;
  if (c.range) {
    const [date, time] = c.range === "start" ? ["2000-01-01", "00:00:00"] : ["9999-12-31", "23:59:59"];
    if (type === "DATE") return date;
    if (type === "TIMESTAMP" || type === "SECONDDATE") return `${date} ${time}`;
    // SAP often keeps a date as text: YYYYMMDD.
    if (compact) return date.replace(/-/g, "");
  }
  if (columnKind(c.type) === "number") return String(n);
  if (columnKind(c.type) === "boolean") return "true";
  const day = `${today.getFullYear()}-01-${String(((n - 1) % 28) + 1).padStart(2, "0")}`;
  if (type === "DATE") return day;
  if (type === "TIME") return "08:00:00";
  if (type === "TIMESTAMP" || type === "SECONDDATE") return `${day} 08:00:00`;
  if (/BINARY|BLOB/.test(type)) return "";
  const number = String(n);
  const max = lengthOf(c.type);
  if (c.key || c.joined) return number.slice(-max);
  const label = `${c.name} ${number}`;
  return label.length <= max ? label : number.slice(-max);
}

/** The grid with a row added, its shown columns prefilled. */
export function addRow(grid: Grid, shown: ScenarioColumn[]): Grid {
  const n = grid.rows.length + 1;
  return { ...grid, rows: [...grid.rows, Object.fromEntries(shown.map((c) => [c.name, prefillText(c, n)]).filter(([, v]) => v !== ""))] };
}

/** The grid with every empty cell of its shown columns prefilled, row by row. */
export function fillEmpty(grid: Grid, shown: ScenarioColumn[]): Grid {
  return {
    ...grid,
    rows: grid.rows.map((row, i) => {
      const out = { ...row };
      for (const c of shown) if ((out[c.name] ?? "") === "") out[c.name] = prefillText(c, i + 1);
      return out;
    }),
  };
}

/** Text copied from a spreadsheet: one line per row, cells apart by tabs. */
export function parsePasted(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

/**
 * The grid with `pasted` written in from row `row` and column `column` (of the
 * `shown` columns) on, with rows added as needed. Cells past the last column
 * are left out. When the first pasted line is the columns' names (a
 * spreadsheet's header), the cells go to the columns they name, in whatever
 * order, shown or not.
 */
export function pasteInto(grid: Grid, row: number, column: number, pasted: string[][], shown: ScenarioColumn[] = grid.columns): Grid {
  const names = grid.columns.map((c) => c.name);
  const header = pasted.length > 1 && pasted[0].every((cell) => names.includes(cell.trim())) ? pasted[0].map((cell) => cell.trim()) : undefined;
  const lines = header ? pasted.slice(1) : pasted;
  const targets = header ?? shown.map((c) => c.name).slice(column);
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

/** The kinds in plain words; the scenario file keeps its own (golden, common, outlying). */
export const KINDS: { kind: ScenarioSpec["kind"]; label: string; hint: string }[] = [
  { kind: "golden", label: "Normal case", hint: "The everyday case, with known results." },
  { kind: "common", label: "Variation", hint: "A frequent variation on it." },
  { kind: "outlying", label: "Edge case", hint: "A rare or extreme case." },
];
export const kindLabel = (kind: string) => KINDS.find((k) => k.kind === kind)?.label ?? kind;

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
