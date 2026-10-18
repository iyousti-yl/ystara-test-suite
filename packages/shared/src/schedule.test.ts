import { describe, expect, it } from "vitest";
import { checkSchedule, describeRun, isTimeZone, nextRun } from "./schedule.js";

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe("checkSchedule", () => {
  it("gives the next runs in the schedule's time zone", () => {
    // Sunday 18 October 2026, 14:00 in Brussels (CEST, UTC+2).
    const check = checkSchedule("30 7 * * 1-5", "Europe/Brussels", new Date("2026-10-18T12:00:00Z"), 3);
    expect(check).toEqual({ ok: true, cron: "30 7 * * 1-5", next: expect.any(Array) });
    if (check.ok) expect(iso(check.next)).toEqual(["2026-10-19T05:30:00.000Z", "2026-10-20T05:30:00.000Z", "2026-10-21T05:30:00.000Z"]);
  });

  it("stores the line with single spaces", () => {
    const check = checkSchedule("  0  6,13 * *   * ", "Europe/Brussels");
    expect(check.ok && check.cron).toBe("0 6,13 * * *");
  });

  it("refuses anything but five fields, with an example", () => {
    for (const line of ["", "0 7 * *", "0 0 7 * * 1-5", "@daily"]) {
      expect(checkSchedule(line, "Europe/Brussels")).toEqual({ ok: false, error: expect.stringContaining('"30 7 * * 1-5"') });
    }
  });

  it("refuses a field out of range, and an unknown time zone", () => {
    expect(checkSchedule("61 7 * * *", "Europe/Brussels")).toEqual({ ok: false, error: expect.stringContaining("not a cron line") });
    expect(checkSchedule("0 7 * * *", "Europe/Atlantis")).toEqual({ ok: false, error: expect.stringContaining("not a time zone") });
    expect(isTimeZone("UTC")).toBe(true);
  });

  it("refuses runs closer than 15 minutes, saying which two", () => {
    const check = checkSchedule("0,10 7 * * *", "Europe/Brussels", new Date("2026-10-18T12:00:00Z"));
    expect(check).toEqual({ ok: false, error: expect.stringContaining("at least 15 minutes apart") });
    expect(!check.ok && check.error).toContain("Mon 19 Oct, 07:00 and Mon 19 Oct, 07:10");
    expect(checkSchedule("*/15 * * * *", "Europe/Brussels").ok).toBe(true);
  });
});

describe("nextRun across daylight saving in Brussels", () => {
  it("runs a time the clock skips once, an hour later", () => {
    // 28 March 2027: 02:00 becomes 03:00, so there is no 02:30.
    expect(nextRun("30 2 * * *", "Europe/Brussels", new Date("2027-03-27T12:00:00Z")).toISOString()).toBe("2027-03-28T01:30:00.000Z");
  });

  it("runs a time the clock repeats once", () => {
    // 25 October 2026: 03:00 becomes 02:00, so 02:30 happens twice.
    const first = nextRun("30 2 * * *", "Europe/Brussels", new Date("2026-10-24T12:00:00Z"));
    expect(first.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(nextRun("30 2 * * *", "Europe/Brussels", first).toISOString()).toBe("2026-10-26T01:30:00.000Z");
  });
});

describe("describeRun", () => {
  it("reads in the schedule's time zone", () => {
    expect(describeRun(new Date("2026-10-19T05:30:00Z"), "Europe/Brussels")).toBe("Mon 19 Oct, 07:30");
    expect(describeRun(new Date("2026-10-19T05:30:00Z"), "UTC")).toBe("Mon 19 Oct, 05:30");
  });
});
