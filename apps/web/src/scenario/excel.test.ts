import { describe, expect, it } from "vitest";
import { readWorkbook, sheetNames, workbookOf } from "./excel";

const ORDERS = {
  key: "SALES.LT_ORDERS_WITH_A_VERY_LONG_TECHNICAL_NAME_X",
  technicalName: "LT_ORDERS_WITH_A_VERY_LONG_TECHNICAL_NAME_X",
  columns: [
    { name: "ORDER_ID", type: "NVARCHAR(10)", key: true },
    { name: "AMOUNT", type: "DECIMAL(15, 2)", used: true },
    { name: "PAID", type: "BOOLEAN" },
    { name: "ORDER_DATE", type: "DATE" },
    { name: "NOTE", type: "NVARCHAR(100)" },
  ],
};
const shown = ORDERS.columns.slice(0, 4);

describe("an Excel workbook of test rows", () => {
  it("names sheets as Excel allows: 31 characters at most, no [ ] : * ? / \\, unique", () => {
    expect(sheetNames(["A/B", "X".repeat(40), "X".repeat(40), "about"])).toEqual(["A_B", "X".repeat(31), `${"X".repeat(29)}~2`, "about~2"]);
  });

  it("reads back what it wrote: codes with leading zeros, exact decimals, booleans and dates", async () => {
    const rows: Record<string, string>[] = [
      { ORDER_ID: "007", AMOUNT: "10.5", PAID: "true", ORDER_DATE: "2026-01-15" },
      { ORDER_ID: "008", AMOUNT: "0.10", ORDER_DATE: "" },
    ];
    const file = await workbookOf([{ key: ORDERS.key, technicalName: ORDERS.technicalName, grid: { columns: ORDERS.columns, rows }, shown }]);
    const read = await readWorkbook(file, [ORDERS]);
    expect(read.problems).toEqual([]);
    expect(read.rows.get(ORDERS.key)).toEqual([
      { ORDER_ID: "007", AMOUNT: "10.5", PAID: "true", ORDER_DATE: "2026-01-15" },
      { ORDER_ID: "008", AMOUNT: "0.10" },
    ]);
  });

  it("says which sheets and columns it left out", async () => {
    const file = await workbookOf([{ key: ORDERS.key, technicalName: ORDERS.technicalName, grid: { columns: ORDERS.columns, rows: [] }, shown }]);
    const read = await readWorkbook(file, [{ ...ORDERS, key: "SALES.OTHER", technicalName: "OTHER" }]);
    expect(read.rows.size).toBe(0);
    expect(read.problems).toEqual([`The sheet "${ORDERS.technicalName.slice(0, 31)}" is no table of this pipeline, so it was left out.`]);
  });
});

describe("a workbook someone filled in", () => {
  it("takes dates Excel stored as dates, and a sheet named after its table without the About sheet", async () => {
    const { default: writeXlsxFile } = await import("write-excel-file/universal");
    const file = await writeXlsxFile([
      {
        sheet: "lt_orders",
        data: [
          ["ORDER_ID", "ORDER_DATE", "NOTE"],
          ["A1", { value: new Date(Date.UTC(2026, 1, 3)), type: Date, format: "yyyy-mm-dd" }, 12],
        ],
      },
    ]).toBlob();
    const read = await readWorkbook(file, [{ ...ORDERS, key: "SALES.LT_ORDERS", technicalName: "LT_ORDERS" }]);
    expect(read.rows.get("SALES.LT_ORDERS")).toEqual([{ ORDER_ID: "A1", ORDER_DATE: "2026-02-03", NOTE: "12" }]);
  });
});
