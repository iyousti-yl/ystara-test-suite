import { describe, expect, it } from "vitest";
import { appLocale, counted, countedAtLeast, countedLatest, formatExact, formatNumber, formatPercent, formatRelative, formatSeconds } from "./format";

describe("the app's locale", () => {
  it("is English in the browser's region, so months are never in another language", () => {
    expect(appLocale(["nl-BE", "nl", "en"])).toBe("en-BE");
    expect(appLocale(["fr-BE"])).toBe("en-BE");
    expect(appLocale(["en-US"])).toBe("en-US");
    expect(appLocale(["en-GB"])).toBe("en-GB");
  });

  it("finds the region of a language given without one, and falls back to plain English", () => {
    expect(appLocale(["nl"])).toBe("en-NL");
    expect(appLocale(["en"])).toBe("en");
    expect(appLocale([])).toBe("en");
    expect(appLocale(["not a tag", "de-DE"])).toBe("en-DE");
  });
});

describe("relative times", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("says how long ago, or how soon, in the largest unit that fits", () => {
    expect(formatRelative(at(-20_000), now)).toBe("just now");
    expect(formatRelative(at(-5 * 60_000), now)).toBe("5 minutes ago");
    expect(formatRelative(at(-3 * 3_600_000), now)).toBe("3 hours ago");
    expect(formatRelative(at(-86_400_000), now)).toBe("yesterday");
    expect(formatRelative(at(2 * 86_400_000), now)).toBe("in 2 days");
    expect(formatRelative(null, now)).toBe("–");
  });
});

describe("counts and measures", () => {
  // The tests run with plain English (no browser region): "1,234".
  it("say one or many, in the app's locale", () => {
    expect(counted(1, "row")).toBe("1 row");
    expect(counted(0, "row")).toBe("0 rows");
    expect(counted(1234, "row")).toBe(`${formatNumber(1234)} rows`);
  });

  it("say when a list stops at its latest page", () => {
    expect(countedLatest(12, false, "snapshot")).toBe("12 snapshots");
    expect(countedLatest(50, true, "snapshot")).toBe("Latest 50 snapshots");
    expect(countedAtLeast(50, true, "scan")).toBe("50 or more scans");
    expect(countedAtLeast(1, false, "scan")).toBe("1 scan");
  });

  it("write seconds, percentages and exact sums the same way everywhere", () => {
    expect(formatSeconds(1234)).toMatch(/^1[.,]2 s$/);
    expect(formatSeconds(null)).toBe("–");
    expect(formatPercent(25)).toBe("25 %");
    expect(formatExact("-1234567.50")).toBe(`-${formatNumber(1234567)}${formatNumber(1.5).charAt(1)}50`);
    expect(formatExact(null)).toBe("–");
  });
});
