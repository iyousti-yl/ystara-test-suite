import type { ScenarioColumn } from "@ystara/shared";
import { cellFromText, columnKind, type Grid } from "./model";

/**
 * Test rows as an Excel workbook, to fill in many rows at once: the builder
 * downloads one sheet per table (row 1 the column names, row 2 their types,
 * then the rows it has) and reads the same file back. Text columns are
 * formatted as text, so Excel keeps codes such as 007 and dates as typed.
 * An "About" sheet says which sheet is which table, since a sheet name is at
 * most 31 characters and a table's can be 50. The two libraries load only
 * when a file is made or read.
 */

/** A table as the workbook has it: the columns its grid shows, and its rows. */
export interface WorkbookTable {
  key: string;
  technicalName: string;
  grid: Grid;
  shown: ScenarioColumn[];
}

const ABOUT = "About";
/** Empty rows formatted ahead of the given ones, so values typed in later keep their text too. */
const SPARE_ROWS = 100;

/** A column's type as row 2 shows it, and as reading the file recognises it. */
export const typeLine = (c: ScenarioColumn) => (c.key ? `${c.type}, key` : c.type);

/** Sheet names Excel takes: at most 31 characters, none of [ ] : * ? / \, unique whatever their case. */
export function sheetNames(names: string[]): string[] {
  const taken = new Set([ABOUT.toLowerCase()]);
  return names.map((name) => {
    const clean = name.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Table";
    let sheet = clean;
    for (let n = 2; taken.has(sheet.toLowerCase()); n++) sheet = `${clean.slice(0, 31 - `~${n}`.length)}~${n}`;
    taken.add(sheet.toLowerCase());
    return sheet;
  });
}

export async function workbookOf(tables: WorkbookTable[]): Promise<Blob> {
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  const bold = (value: string) => ({ value, fontWeight: "bold" as const });
  const names = sheetNames(tables.map((t) => t.technicalName));
  const cell = (text: string, c: ScenarioColumn) => {
    if (columnKind(c.type) === "text" || !text) return { value: text || undefined, type: String, format: "@" };
    const { cell: value, invalid } = cellFromText(text, c.type);
    // A decimal a JavaScript number would round stays text, as in the grid.
    if (invalid || typeof value === "string" || value === undefined || value === null) return { value: text, type: String };
    return typeof value === "boolean" ? { value, type: Boolean } : { value, type: Number };
  };
  const about = [
    [bold("Test rows for a Ystara scenario")],
    ["One sheet per table. Row 1 names the columns and row 2 gives their types; each row after that is a test row."],
    ["An empty cell is NULL. Use made-up values, never rows copied from the tenant. Then upload this file in the scenario."],
    [],
    [bold("Sheet"), bold("Table"), bold("Columns")],
    ...tables.map((t, i) => [names[i], t.key, t.shown.length]),
  ];
  const sheets = tables.map((t, i) => ({
    sheet: names[i],
    stickyRowsCount: 2,
    columns: t.shown.map((c) => ({ width: Math.min(40, Math.max(12, c.name.length + 2, typeLine(c).length + 2)) })),
    data: [
      t.shown.map((c) => bold(c.name)),
      t.shown.map((c) => ({ value: typeLine(c), fontStyle: "italic" as const, textColor: "#6A6D70" })),
      ...t.grid.rows.map((row) => t.shown.map((c) => cell(row[c.name] ?? "", c))),
      ...Array.from({ length: SPARE_ROWS }, () => t.shown.map((c) => cell("", c))),
    ],
  }));
  return writeXlsxFile([{ sheet: ABOUT, data: about, columns: [{ width: 24 }, { width: 60 }, { width: 10 }] }, ...sheets]).toBlob();
}

/** What reading a workbook gave: the rows of each table it has a sheet for (by key), and what was left out. */
export interface ReadWorkbook {
  rows: Map<string, Record<string, string>[]>;
  problems: string[];
}

/**
 * Reads a workbook back: each sheet goes to its table (by the About sheet,
 * else by the table's name), each column to the column named in row 1, and
 * row 2 is skipped when it is the types line. Rows left empty are skipped.
 * Values come back as the grid's text: numbers exactly as Excel stored them,
 * dates by the column's type.
 */
export async function readWorkbook(file: Blob, tables: { key: string; technicalName: string; columns: ScenarioColumn[] }[]): Promise<ReadWorkbook> {
  const { default: readXlsxFile } = await import("read-excel-file/universal");
  const sheets = await readXlsxFile(file, { parseNumber: (text) => text, trim: false });
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

  // The About sheet's list: Sheet, Table.
  const named = new Map<string, string>();
  const about = sheets.find((s) => s.sheet === ABOUT);
  for (const row of about?.data ?? []) {
    const [sheet, key] = row.map(text);
    if (sheet && tables.some((t) => t.key === key)) named.set(sheet, key);
  }
  const tableOf = (sheet: string) => {
    const key = named.get(sheet);
    if (key) return tables.find((t) => t.key === key);
    const lower = sheet.toLowerCase();
    return tables.find((t) => t.key.toLowerCase() === lower || t.technicalName.toLowerCase() === lower || t.technicalName.slice(0, 31).toLowerCase() === lower);
  };

  const rows = new Map<string, Record<string, string>[]>();
  const problems: string[] = [];
  for (const { sheet, data } of sheets) {
    if (sheet === ABOUT) continue;
    const table = tableOf(sheet);
    if (!table) {
      if (data.some((r) => r.some((v) => text(v) !== ""))) problems.push(`The sheet "${sheet}" is no table of this pipeline, so it was left out.`);
      continue;
    }
    const header = (data[0] ?? []).map(text);
    const columns = header.map((name) => table.columns.find((c) => c.name === name));
    const unknown = header.filter((name, i) => name && !columns[i]);
    if (unknown.length) problems.push(`${table.technicalName} has no column ${unknown.join(", ")}: ${unknown.length === 1 ? "it was" : "they were"} left out.`);
    const typesRow = data[1]?.every((v, i) => text(v) === "" || (columns[i] && text(v).toLowerCase() === typeLine(columns[i]!).toLowerCase()));
    const read: Record<string, string>[] = [];
    for (const row of data.slice(typesRow ? 2 : 1)) {
      const out: Record<string, string> = {};
      row.forEach((v, i) => {
        const c = columns[i];
        const value = c ? gridText(v, c.type) : "";
        if (c && value !== "") out[c.name] = value;
      });
      if (Object.keys(out).length) read.push(out);
    }
    if (rows.has(table.key)) problems.push(`Two sheets are for ${table.technicalName}; the second one was used.`);
    rows.set(table.key, read);
  }
  return { rows, problems };
}

/** A value Excel holds, as the grid's text for a column of `type`. */
function gridText(v: unknown, type: string): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return String(v);
  if (v instanceof Date) {
    const iso = v.toISOString(); // Excel's dates have no time zone: read as UTC, written back as they were.
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 19);
    if (/^DATE\b/i.test(type)) return date;
    if (/^TIME\b/i.test(type)) return time;
    return time === "00:00:00" && !/^(TIMESTAMP|SECONDDATE)\b/i.test(type) ? date : `${date} ${time}`;
  }
  return String(v);
}
