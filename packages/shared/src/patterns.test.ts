import { describe, expect, it } from "vitest";
import { matchesPattern } from "./patterns.js";

describe("writer patterns", () => {
  const ref = { space: "HR", technicalName: "DF_EMPLOYEE_BACKFILL" };
  it("match a name or SPACE.NAME, with wildcards, ignoring case", () => {
    for (const p of ["DF_EMPLOYEE_BACKFILL", "hr.df_employee_backfill", "DF_*", "*_BACKFIL?"]) expect(matchesPattern(p, ref), p).toBe(true);
  });
  it("take dots and other characters literally", () => {
    for (const p of ["DF_EMPLOYEE", "OTHER.DF_EMPLOYEE_BACKFILL", "DF.EMPLOYEE_BACKFILL", "DF_(.*)"]) expect(matchesPattern(p, ref), p).toBe(false);
  });
});
