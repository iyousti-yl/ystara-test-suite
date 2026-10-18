import { describe, expect, it } from "vitest";
import { monoColumnWidth } from "./columns";

describe("monoColumnWidth", () => {
  it("fits the longest text, and never more than the table", () => {
    expect(monoColumnWidth(["LT_SHORT", `V_${"X".repeat(38)}`, undefined])).toBe("min(calc(40 * 0.61em + 1.5rem), 100%)");
  });

  it("keeps a floor for short texts and empty tables", () => {
    expect(monoColumnWidth([])).toBe("min(calc(10 * 0.61em + 1.5rem), 100%)");
    expect(monoColumnWidth(["ID"], 6)).toBe("min(calc(6 * 0.61em + 1.5rem), 100%)");
  });
});
