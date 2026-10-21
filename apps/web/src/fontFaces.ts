/** The subsets bundled: Western and Central European languages. */
const SUBSETS = /-(latin|latin-ext)-\d+-normal\.woff2$/;

/**
 * The @font-face rules of a Fontsource stylesheet for the subsets bundled
 * (latin, latin-ext), each pointing at its bundled woff2 file; a face without
 * one is dropped. With `alias`, the same faces under another family name and
 * for any weight asked: UI5 asks for its bold text by family ("72-Bold"), so
 * Plex's 600 needs a family of its own.
 */
export function plexFaces(css: string, urls: Map<string, string>, alias?: string): string {
  return css
    .split("@font-face")
    .slice(1)
    .map((rule) => {
      const file = rule.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1];
      const url = file && SUBSETS.test(file) && urls.get(file);
      if (!url) return "";
      let face = rule.slice(0, rule.indexOf("}") + 1).replace(/src:[^;]+;/, `src: url(${url}) format('woff2');`);
      if (alias) face = face.replace(/font-family:[^;]+;/, `font-family: '${alias}';`).replace(/font-weight:[^;]+;/, "font-weight: 100 900;");
      return "@font-face" + face;
    })
    .filter(Boolean)
    .join("\n");
}
