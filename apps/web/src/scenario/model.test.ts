import { describe, expect, it } from "vitest";
import { cellFromText, columnKind, gridFromRows, parsePasted, pasteInto, rowsFromGrid, textFromCell } from "./model";

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
