import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv.js";

describe("CSV for audit exports", () => {
  it("quotes what needs it and doubles quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", then go')).toBe('"say ""hi"", then go"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(new Date("2026-10-22T08:00:00Z"))).toBe("2026-10-22T08:00:00.000Z");
  });

  it("keeps a typed formula from running in a spreadsheet", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@sum")).toBe("'@sum");
    // A number is a number, not a formula.
    expect(csvCell(-3)).toBe("-3");
  });

  it("starts with a byte order mark and ends lines with CRLF", () => {
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("﻿a,b\r\n1,x\r\n");
  });
});
