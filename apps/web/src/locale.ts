import { registerLocaleDataLoader, type CLDRData } from "@ui5/webcomponents-base/dist/asset-registries/LocaleData.js";
import { setLanguage } from "@ui5/webcomponents-base/dist/config/Language.js";

/**
 * The app is in English. UI5 also needs locale data (CLDR) for that language,
 * and without a registered copy it downloads it from a public CDN; this
 * registers the bundled English copy instead. Our own dates and numbers use
 * the browser's Intl (see format.ts), so they still follow the user's region.
 */
// UI5's CLDRData type doesn't allow the numbers its own en.json contains, hence the cast.
const english = async () => (await import("@ui5/webcomponents-localization/dist/generated/assets/cldr/en.json")).default as unknown as CLDRData;
registerLocaleDataLoader("en", english);
void setLanguage("en");
