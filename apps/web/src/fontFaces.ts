/** UI5's @font-face rules with each CDN URL replaced by the bundled file. A face without a bundled file is dropped. */
export function localFontFaces(css: string, urls: Map<string, string>): string {
  return css
    .split("@font-face")
    .map((rule) => {
      const file = rule.match(/url\(https:\/\/[^)]*\/fonts\/([^)]+)\)/)?.[1];
      const url = file && urls.get(file);
      return url ? "@font-face" + rule.replace(/url\(https:\/\/[^)]*\)/, `url(${url})`) : "";
    })
    .filter(Boolean)
    .join("\n");
}
