import { setDefaultFontLoading } from "@ui5/webcomponents-base/dist/config/Fonts.js";
import ui5FontFaces from "@ui5/webcomponents-base/dist/generated/css/FontFace.css.js";
import { localFontFaces } from "./fontFaces";

/**
 * SAP's "72" font, served by Ystara itself.
 *
 * By default UI5 downloads the font from a public CDN, which tells a third
 * party who uses the app (a GDPR question, and it fails offline). Instead we
 * turn that off and register the same font faces with the files bundled into
 * this app from @sap-theming/theming-base-content (alias in vite.config.ts).
 */
const files = import.meta.glob<string>("@ui5-fonts/*.woff2", { query: "?url", import: "default", eager: true });
const urlByFile = new Map(Object.entries(files).map(([file, url]) => [file.split("/").pop()!, url]));

setDefaultFontLoading(false);
const style = document.createElement("style");
style.dataset.ystara = "fonts";
style.textContent = localFontFaces(ui5FontFaces, urlByFile);
document.head.append(style);
