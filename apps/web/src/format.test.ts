import { describe, expect, it } from "vitest";
import { appLocale, formatRelative } from "./format";

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
