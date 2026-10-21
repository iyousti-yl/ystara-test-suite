import { Button } from "@ui5/webcomponents-react";
import type { ClipboardEvent } from "react";
import { counted } from "../format";
import { addRow, cellFromText, columnKind, columnNote, fillEmpty, parsePasted, pasteInto, shownColumns, type Grid } from "./model";

/**
 * Test rows as a grid of plain inputs, one column per column of the table
 * (its name and type in the header). It shows the table's keys and the
 * columns the pipeline reads, or every column when asked: a hidden column is
 * NULL. Added test rows start with values that get through the pipeline's
 * filters and joins (prefillText); expected rows start empty. Rows can be
 * duplicated and removed. Rows copied
 * from a spreadsheet are pasted in at the cell that has the focus, with a
 * header line or without. A cell left empty is NULL. A value that doesn't fit
 * its column's type is marked, with what it takes.
 * Plain inputs, not ui5-input: a grid of hundreds of shadow-DOM fields is slow.
 */
export function RowsGrid(props: {
  grid: Grid;
  onChange: (grid: Grid) => void;
  readOnly?: boolean;
  label: string;
  /** Every column, not only the keys and those the pipeline reads; offered when `onAllColumns` is given. */
  allColumns?: boolean;
  onAllColumns?: (all: boolean) => void;
  /** Added rows and empty cells get values that get through (test rows); without it, rows start empty (expected rows). */
  prefill?: boolean;
}) {
  const { grid, onChange, readOnly, label, onAllColumns, prefill = true } = props;
  const allColumns = props.allColumns ?? !onAllColumns;
  const shown = shownColumns(grid, allColumns);
  const hidden = onAllColumns ? grid.columns.length - shownColumns(grid).length : 0;
  const setCell = (row: number, column: string, text: string) => onChange({ ...grid, rows: grid.rows.map((r, i) => (i === row ? { ...r, [column]: text } : r)) });
  const onPaste = (row: number, column: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return; // one value: the input takes it itself
    e.preventDefault();
    onChange(pasteInto(grid, row, column, parsePasted(text), shown));
  };

  return (
    <div className="rows-grid">
      <div className="rows-grid-scroll">
        <table aria-label={label}>
          <thead>
            <tr>
              <th className="rows-grid-number" scope="col">
                <span className="sr-only">Row</span>
              </th>
              {shown.map((c) => (
                <th key={c.name} scope="col" title={columnNote(c) || undefined}>
                  <span className="mono">{c.name}</span>
                  <span className="rows-grid-type">
                    {c.type || "not a column of the table"}
                    {c.key && <span className="rows-grid-key"> · key</span>}
                    {!c.key && (c.used || c.keeps !== undefined) && <span className="rows-grid-used"> · used</span>}
                  </span>
                </th>
              ))}
              {!readOnly && (
                <th className="rows-grid-actions" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, i) => (
              <tr key={i}>
                <th className="rows-grid-number" scope="row">
                  {i + 1}
                </th>
                {shown.map((c, j) => {
                  const text = row[c.name] ?? "";
                  const { invalid } = cellFromText(text, c.type);
                  return (
                    <td key={c.name}>
                      <input
                        className={columnKind(c.type) === "number" ? "rows-grid-input mono is-number" : "rows-grid-input mono"}
                        value={text}
                        readOnly={readOnly}
                        placeholder="NULL"
                        aria-label={`${c.name}, row ${i + 1}`}
                        aria-invalid={invalid ? true : undefined}
                        title={invalid}
                        inputMode={columnKind(c.type) === "number" ? "decimal" : undefined}
                        onChange={(e) => setCell(i, c.name, e.target.value)}
                        onPaste={readOnly ? undefined : onPaste(i, j)}
                      />
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="rows-grid-actions">
                    <Button
                      design="Transparent"
                      icon="copy"
                      tooltip={`Duplicate row ${i + 1}`}
                      accessibleName={`Duplicate row ${i + 1}`}
                      onClick={() => onChange({ ...grid, rows: [...grid.rows.slice(0, i + 1), { ...row }, ...grid.rows.slice(i + 1)] })}
                    />
                    <Button
                      design="Transparent"
                      icon="delete"
                      tooltip={`Remove row ${i + 1}`}
                      accessibleName={`Remove row ${i + 1}`}
                      onClick={() => onChange({ ...grid, rows: grid.rows.filter((_, k) => k !== i) })}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="rows-grid-toolbar">
          <Button
            icon="add"
            tooltip={prefill ? "A row with values that get through the pipeline's filters and joins" : undefined}
            onClick={() => onChange(prefill ? addRow(grid, shown) : { ...grid, rows: [...grid.rows, {}] })}
          >
            Add row
          </Button>
          {prefill && grid.rows.length > 0 && (
            <Button design="Transparent" icon="write-new" tooltip="Give every empty cell a value, as Add row does" onClick={() => onChange(fillEmpty(grid, shown))}>
              Fill empty cells
            </Button>
          )}
          {hidden > 0 && onAllColumns && (
            <Button design="Transparent" icon={allColumns ? "hide" : "show"} onClick={() => onAllColumns(!allColumns)}>
              {allColumns ? "Show only the columns used" : `Show all ${grid.columns.length} columns`}
            </Button>
          )}
          <span className="muted">
            {hidden > 0 && !allColumns ? `${counted(hidden, "column")} the pipeline doesn't read ${hidden === 1 ? "is" : "are"} hidden and stay${hidden === 1 ? "s" : ""} NULL. ` : ""}
            Empty cells are NULL. To paste rows from a spreadsheet, click a cell and paste; a header line puts each value in its column.
          </span>
        </div>
      )}
    </div>
  );
}
