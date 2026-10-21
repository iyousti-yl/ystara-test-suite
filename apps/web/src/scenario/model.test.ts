import { describe, expect, it } from "vitest";
import { addRow, cellFromText, columnKind, columnNote, fillEmpty, gridFromRows, parsePasted, pasteInto, prefillText, rowsFromGrid, shownColumns, textFromCell } from "./model";

const columns = [
  { name: "ID", type: "NVARCHAR(10)" },
  { name: "AMOUNT", type: "DECIMAL(15, 2)" },
  { name: "ACTIVE", type: "BOOLEAN" },
];

describe("a typed cell", () => {
  it("is read by its column's type, with a comma or a point as the decimal sign", () => {
    expect(columnKind("DECIMAL(15, 2)")).toBe("number");
    expect(columnKind("INTEGER")).toBe("number");
    expect(columnKind("NVARCHAR(10)")).toBe("text");
    expect(columnKind("DATE")).toBe("text");
    expect(cellFromText("10,5", "DECIMAL(15, 2)")).toEqual({ cell: 10.5 });
    expect(cellFromText(" -3 ", "INTEGER")).toEqual({ cell: -3 });
    expect(cellFromText("yes", "BOOLEAN")).toEqual({ cell: true });
    expect(cellFromText("007", "NVARCHAR(10)")).toEqual({ cell: "007" });
  });

  it("keeps as text a decimal a JavaScript number would round, and says when a value doesn't fit", () => {
    expect(cellFromText("0.10", "DECIMAL(15, 2)")).toEqual({ cell: "0.10" });
    expect(cellFromText("12345678901234567890.12", "DECIMAL(31, 2)")).toEqual({ cell: "12345678901234567890.12" });
    expect(cellFromText("ten", "INTEGER")).toEqual({ cell: "ten", invalid: "INTEGER takes a number" });
    expect(cellFromText("maybe", "BOOLEAN")).toEqual({ cell: "maybe", invalid: "BOOLEAN takes true or false" });
  });

  it("is NULL when left empty: the row leaves the column out", () => {
    expect(cellFromText("", "NVARCHAR(10)")).toEqual({ cell: undefined });
    expect(textFromCell(null)).toBe("");
    expect(rowsFromGrid({ columns, rows: [{ ID: "1", AMOUNT: "", ACTIVE: "false" }, {}] })).toEqual([{ ID: "1", ACTIVE: false }, {}]);
  });
});

describe("a grid", () => {
  it("keeps the columns its rows name that the table doesn't have, so nothing is dropped", () => {
    const grid = gridFromRows(columns, [{ ID: "1", AMOUNT: 2.5, OLD: "x" }]);
    expect(grid.columns.map((c) => c.name)).toEqual(["ID", "AMOUNT", "ACTIVE", "OLD"]);
    expect(grid.rows).toEqual([{ ID: "1", AMOUNT: "2.5", OLD: "x" }]);
    expect(rowsFromGrid(grid)).toEqual([{ ID: "1", AMOUNT: 2.5, OLD: "x" }]);
  });

  it("takes rows pasted from a spreadsheet, from the cell they are pasted in, adding rows", () => {
    const pasted = parsePasted("1\t10,5\r\n2\t3\r\n");
    expect(pasted).toEqual([
      ["1", "10,5"],
      ["2", "3"],
    ]);
    const grid = pasteInto({ columns, rows: [{ ID: "0" }] }, 0, 0, pasted);
    expect(rowsFromGrid(grid)).toEqual([
      { ID: "1", AMOUNT: 10.5 },
      { ID: "2", AMOUNT: 3 },
    ]);
    // From the second column on, a third cell has no column left.
    expect(pasteInto({ columns, rows: [] }, 1, 1, [["4", "true", "extra"]]).rows).toEqual([{}, { AMOUNT: "4", ACTIVE: "true" }]);
  });

  it("puts each pasted cell in the column a header line names, in any order", () => {
    const grid = pasteInto({ columns, rows: [] }, 0, 0, parsePasted("AMOUNT\tID\n7\tA\n"));
    expect(grid.rows).toEqual([{ AMOUNT: "7", ID: "A" }]);
  });
});

describe("a table with many columns", () => {
  const wide = {
    columns: [
      { name: "EMP_ID", type: "NVARCHAR(8)", key: true },
      { name: "FAX", type: "NVARCHAR(20)" },
      { name: "ORG_ID", type: "NVARCHAR(10)", used: true, joined: true },
      { name: "STATUS", type: "NVARCHAR(1)", used: true, keeps: "A" },
      { name: "VALID_TO", type: "DATE", used: true, range: "end" as const },
      { name: "START_DT", type: "NVARCHAR(8)", used: true, range: "start" as const },
      { name: "CITY", type: "NVARCHAR(40)" },
      { name: "HOURS", type: "DECIMAL(5, 2)", used: true },
    ],
    rows: [{ CITY: "Gent" }],
  };

  it("shows its keys, the columns the pipeline reads and those with a value, or all of them", () => {
    expect(shownColumns(wide).map((c) => c.name)).toEqual(["EMP_ID", "ORG_ID", "STATUS", "VALID_TO", "START_DT", "CITY", "HOURS"]);
    expect(shownColumns(wide, true)).toHaveLength(8);
    // A scan that says nothing of how the columns are used shows them all.
    expect(shownColumns({ columns: columns, rows: [] })).toHaveLength(3);
  });

  it("starts new rows with values that get through the filters and join row by row", () => {
    const shown = shownColumns(wide);
    const grid = addRow(addRow({ ...wide, rows: [] }, shown), shown);
    expect(grid.rows).toEqual([
      { EMP_ID: "1", ORG_ID: "1", STATUS: "A", VALID_TO: "9999-12-31", START_DT: "20000101", CITY: "CITY 1", HOURS: "1" },
      { EMP_ID: "2", ORG_ID: "2", STATUS: "A", VALID_TO: "9999-12-31", START_DT: "20000101", CITY: "CITY 2", HOURS: "2" },
    ]);
    expect(fillEmpty(wide, shown).rows[0]).toMatchObject({ EMP_ID: "1", CITY: "Gent" });
    expect(prefillText({ name: "A_LONG_NAME", type: "NVARCHAR(3)" }, 12)).toBe("12");
    expect(prefillText({ name: "DAY", type: "DATE" }, 30, new Date(2026, 5, 1))).toBe("2026-01-02");
    expect(prefillText({ name: "FLAG", type: "NVARCHAR(1)", keeps: null }, 1)).toBe("");
  });

  it("says in its header what the pipeline does with a column", () => {
    expect(columnNote(wide.columns[3])).toBe('A filter keeps "A".');
    expect(columnNote(wide.columns[0])).toBe("A key column.");
    expect(columnNote(wide.columns[2])).toBe("Joined with a column of another table.");
    expect(columnNote(wide.columns[1])).toBe("");
  });

  it("pastes rows without a header into the shown columns, in their order", () => {
    const shown = shownColumns(wide);
    expect(pasteInto({ ...wide, rows: [] }, 0, 0, [["E1", "O1"]], shown).rows).toEqual([{ EMP_ID: "E1", ORG_ID: "O1" }]);
  });
});
