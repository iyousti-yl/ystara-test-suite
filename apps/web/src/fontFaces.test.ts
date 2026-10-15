import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ui5FontFaces from "@ui5/webcomponents-base/dist/generated/css/FontFace.css.js";
import { localFontFaces } from "./fontFaces";

const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve("@sap-theming/theming-base-content/package.json")), "content/Base/baseLib/baseTheme/fonts");
const referenced = [...ui5FontFaces.matchAll(/\/fonts\/([^)]+)\)/g)].map((m) => m[1]);

describe("the 72 font", () => {
  it("has a bundled file for every face UI5 uses (the two packages must stay on matching versions)", () => {
    expect(referenced.length).toBeGreaterThan(10);
    expect(referenced.filter((file) => !existsSync(path.join(fontDir, file)))).toEqual([]);
  });

  it("is never fetched from a CDN", () => {
    const urls = new Map(referenced.map((file) => [file, `/assets/${file}`]));
    const css = localFontFaces(ui5FontFaces, urls);
    expect(css).not.toMatch(/https?:/);
    expect(css.match(/@font-face/g)).toHaveLength(ui5FontFaces.match(/@font-face/g)!.length);
    expect(localFontFaces(ui5FontFaces, new Map())).toBe("");
  });
});
