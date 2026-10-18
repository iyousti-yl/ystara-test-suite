/**
 * The minimum width (TableHeaderCell's minWidth) of a table column of
 * technical names or other text in .mono that has no spaces to wrap at: wide
 * enough for the longest one on one line, so the other columns shrink first,
 * then move under the row, before a name has to break. Never wider than the
 * table: a name too long for a phone wraps there after all. `atLeast` is in
 * characters too, for a short column's header.
 *
 * 72Mono is 0.602em a character (measured in Chromium at 14px, the table's
 * size); 0.61em leaves room for a fallback font. 1.5rem is a cell's padding.
 */
export function monoColumnWidth(texts: Iterable<string | null | undefined>, atLeast = 10): string {
  let longest = atLeast;
  for (const text of texts) longest = Math.max(longest, text?.length ?? 0);
  return `min(calc(${longest} * 0.61em + 1.5rem), 100%)`;
}
