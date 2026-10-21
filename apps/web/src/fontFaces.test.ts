import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { plexFaces } from "./fontFaces";

const require = createRequire(import.meta.url);
const stylesheet = (font: string, weight: number) =>
  readFileSync(path.join(path.dirname(require.resolve(`@fontsource/${font}/package.json`)), `${weight}.css`), "utf8");
const filesOf = (css: string) => [...css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((m) => m[1]);

describe("IBM Plex, served by Ystara itself", () => {
  const css = stylesheet("ibm-plex-sans", 600);
  const urls = new Map(filesOf(css).map((file) => [file, `/assets/${file}`]));

  it("keeps the Latin subsets, with their unicode ranges, and only the bundled woff2", () => {
    const faces = plexFaces(css, urls);
    expect(faces.match(/@font-face/g)).toHaveLength(2);
    expect(faces).toContain("/assets/ibm-plex-sans-latin-600-normal.woff2");
    expect(faces).toContain("/assets/ibm-plex-sans-latin-ext-600-normal.woff2");
    expect(faces).toMatch(/unicode-range: U\+0000-00FF/);
    expect(faces).not.toMatch(/\.woff\)|cyrillic|greek|https?:/);
    expect(plexFaces(css, new Map())).toBe("");
  });

  it("gives the semibold faces a family of their own, for any weight UI5 asks", () => {
    const faces = plexFaces(css, urls, "Ystara Plex Semibold");
    expect(faces).toContain("font-family: 'Ystara Plex Semibold';");
    expect(faces).toContain("font-weight: 100 900;");
    expect(faces).not.toContain("IBM Plex Sans");
  });
});
