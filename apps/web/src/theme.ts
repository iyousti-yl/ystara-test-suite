import { useSyncExternalStore } from "react";
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
// Theme parameters for the dark theme (the light one is built in).
import "@ui5/webcomponents-theming/dist/generated/json-imports/Themes.js";
import "@ui5/webcomponents/dist/generated/json-imports/Themes.js";
import "@ui5/webcomponents-fiori/dist/generated/json-imports/Themes.js";

/** Follows the operating system's light or dark setting, live, with SAP's Horizon themes. */
const query = window.matchMedia("(prefers-color-scheme: dark)");
const apply = () => setTheme(query.matches ? "sap_horizon_dark" : "sap_horizon");
apply();
query.addEventListener("change", apply);

export function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => query.matches,
  );
}
