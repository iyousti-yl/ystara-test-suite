import { describe, expect, it } from "vitest";
import light from "@ui5/webcomponents-theming/dist/generated/themes/sap_horizon/parameters-bundle.css.js";
import dark from "@ui5/webcomponents-theming/dist/generated/themes/sap_horizon_dark/parameters-bundle.css.js";
import { BRAND, brandCss, brandParameters, DARK, recolour } from "./brand";

/** WCAG relative luminance and contrast of two #rrggbb colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const full = (hex: string) => (hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(0, 7));

/** A colour's hue (0-360) and saturation, to find the SAP blues and greens left. */
function hueOf(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full(hex).slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const hue = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { hue: (hue + 360) % 360, saturation };
}

/** Every parameter's value once the brand is on, decorative palettes left out. */
function branded(themeCss: string, theme: "light" | "dark"): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of themeCss.matchAll(/(--sap[A-Za-z0-9_]+):\s*([^;]+);/g)) {
    if (!/Chart|Legend|Shell_Category|Avatar_|IndicationColor|Illustrative|AccentColor|AccentBackground|Assistant/.test(name)) out.set(name, value);
  }
  for (const [name, value] of Object.entries(brandParameters(themeCss, theme))) out.set(name, value);
  return out;
}

describe("the youlytics brand layer", () => {
  it("swaps SAP colours, in hex and in rgba, and leaves the rest", () => {
    const map = { "#0070f2": BRAND.sapphire, "rgb:34,53,72": "20,32,51" };
    expect(recolour("#0070F2", map)).toBe(BRAND.sapphire);
    expect(recolour("0 0 .125rem 0 rgba(34,53,72,.15), 0 .5rem 1rem 0 rgba(34, 53, 72, .15)", map)).toBe(
      "0 0 .125rem 0 rgba(20,32,51,.15), 0 .5rem 1rem 0 rgba(20,32,51, .15)",
    );
    expect(recolour("#fff", map)).toBe("#fff");
  });

  for (const [theme, css] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`leaves no SAP blue, green or yellow in the ${theme} theme's parameters`, () => {
      const left: string[] = [];
      for (const [name, value] of branded(css, theme)) {
        for (const hex of value.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
          const { hue, saturation } = hueOf(hex);
          // Brand sapphire sits at hue 219 with saturation 0.57; SAP's blues are far more saturated.
          const sapBlue = hue >= 195 && hue <= 225 && saturation > 0.75;
          const green = hue >= 70 && hue <= 165 && saturation > 0.3;
          // Brand amber and its tints sit at hue 37 to 40; SAP's warning yellows from 45 on.
          const yellow = hue >= 45 && hue < 70 && saturation > 0.6;
          if (sapBlue || green || yellow) left.push(`${name}: ${value}`);
        }
      }
      expect(left).toEqual([]);
    });
  }

  it("makes the primary action amber with ink text, and brand colours of links, text and the ground", () => {
    const l = branded(light, "light");
    expect(l.get("--sapButton_Emphasized_Background")).toBe(BRAND.amber);
    expect(l.get("--sapButton_Emphasized_TextColor")).toBe(BRAND.ink);
    expect(l.get("--sapBrandColor")).toBe(BRAND.sapphire);
    expect(l.get("--sapLinkColor")).toBe(BRAND.sapphire);
    expect(l.get("--sapTextColor")).toBe(BRAND.ink);
    expect(l.get("--sapBackgroundColor")).toBe(BRAND.mist);
    expect(l.get("--sapNegativeColor")).toBe(BRAND.ruby);
    const d = branded(dark, "dark");
    expect(d.get("--sapBackgroundColor")).toBe(DARK.ground);
    expect(d.get("--sapAvatar_6_Background")).toBe(BRAND.sapphire);
    expect(d.get("--sapTextColor")).toBe(DARK.text);
    expect(d.get("--sapButton_Emphasized_TextColor")).toBe(BRAND.ink);
  });

  it("keeps every text colour readable on its ground (WCAG AA, 4.5:1)", () => {
    for (const [theme, css] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const p = branded(css, theme);
      const pairs: [string, string][] = [
        ["--sapTextColor", "--sapBackgroundColor"],
        ["--sapTextColor", "--sapGroup_ContentBackground"],
        ["--sapContent_LabelColor", "--sapBackgroundColor"],
        ["--sapContent_LabelColor", "--sapGroup_ContentBackground"],
        ["--sapLinkColor", "--sapGroup_ContentBackground"],
        ["--sapNegativeTextColor", "--sapGroup_ContentBackground"],
        ["--sapCriticalTextColor", "--sapGroup_ContentBackground"],
        ["--sapPositiveTextColor", "--sapGroup_ContentBackground"],
        ["--sapButton_TextColor", "--sapButton_Background"],
        ["--sapButton_Emphasized_TextColor", "--sapButton_Emphasized_Background"],
        ["--sapButton_Success_TextColor", "--sapButton_Success_Background"],
        ["--sapButton_Negative_TextColor", "--sapButton_Negative_Background"],
        ["--sapButton_Critical_TextColor", "--sapButton_Critical_Background"],
        ["--sapButton_Information_TextColor", "--sapButton_Information_Background"],
      ];
      for (const [text, ground] of pairs) {
        const ratio = contrast(full(p.get(text)!), full(p.get(ground)!));
        expect(ratio, `${theme}: ${text} ${p.get(text)} on ${ground} ${p.get(ground)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("outranks UI5's own parameters, light and dark apart", () => {
    const css = brandCss();
    expect(css).toContain(':root:root:not([data-theme="dark"]){');
    expect(css).toContain(':root:root[data-theme="dark"]{');
    expect(css).toContain('--sapFontFamily:"IBM Plex Sans"');
    expect(css).not.toMatch(/"72/);
  });
});
