import { setDefaultFontLoading } from "@ui5/webcomponents-base/dist/config/Fonts.js";
import mono400 from "@fontsource/ibm-plex-mono/400.css?raw";
import mono500 from "@fontsource/ibm-plex-mono/500.css?raw";
import mono600 from "@fontsource/ibm-plex-mono/600.css?raw";
import sans400 from "@fontsource/ibm-plex-sans/400.css?raw";
import sans500 from "@fontsource/ibm-plex-sans/500.css?raw";
import sans600 from "@fontsource/ibm-plex-sans/600.css?raw";
import { plexFaces } from "./fontFaces";

/**
 * IBM Plex Sans and Plex Mono, the youlytics typefaces (brand.ts), served by
 * Ystara itself from the Fontsource packages (aliases in vite.config.ts).
 * UI5 would download its own font, "72", from a public CDN, which tells a
 * third party who uses the app (a GDPR question, and it fails offline): that
 * is turned off, and no page asks for 72 any more.
 */
// The weights the brand uses (400, 500, 600), in the latin and latin-ext subsets.
const files = import.meta.glob<string>(["@plex-sans/*-latin*-{400,500,600}-normal.woff2", "@plex-mono/*-latin*-{400,500,600}-normal.woff2"], {
  query: "?url",
  import: "default",
  eager: true,
});
const urls = new Map(Object.entries(files).map(([file, url]) => [file.split("/").pop()!, url]));

setDefaultFontLoading(false);
const style = document.createElement("style");
style.dataset.ystara = "fonts";
style.textContent = [
  plexFaces(sans400, urls),
  plexFaces(sans500, urls),
  plexFaces(sans600, urls),
  plexFaces(sans500, urls, "Ystara Plex Medium"),
  plexFaces(sans600, urls, "Ystara Plex Semibold"),
  plexFaces(mono400, urls),
  plexFaces(mono500, urls),
  plexFaces(mono600, urls),
  plexFaces(mono600, urls, "Ystara Plex Mono Semibold"),
].join("\n");
document.head.append(style);
