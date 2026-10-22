/**
 * CSV for the audit exports (RFC 4180: commas, CRLF, quotes doubled), with a
 * UTF-8 byte order mark so Excel reads accents right. A cell that starts with
 * =, +, -, @, a tab or a carriage return gets a leading apostrophe: a
 * spreadsheet would otherwise run it as a formula, and names and comments come
 * from users.
 */
export type CsvCell = string | number | boolean | Date | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
