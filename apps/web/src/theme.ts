import { useSyncExternalStore } from "react";
import { setTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
// Theme parameters for the dark theme (the light one is built in).
import "@ui5/webcomponents-theming/dist/generated/json-imports/Themes.js";
import "@ui5/webcomponents/dist/generated/json-imports/Themes.js";
import "@ui5/webcomponents-fiori/dist/generated/json-imports/Themes.js";

/**
 * Light or dark, with SAP's Horizon themes in the youlytics colours (brand.ts): light unless the person picks Dark,
 * or "Same as the system" (the operating system's setting, followed live), in
 * the account menu. The pick is kept in this browser (localStorage), and other
 * tabs follow it.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Same as the system" },
];

/** Where the pick is kept; tools/check/browser.ts sets it for --dark. */
export const THEME_KEY = "ystara.theme";

const query = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "system" ? value : "light";
  } catch {
    return "light"; // storage blocked: light, as for a new browser
  }
}

let preference = stored();
const isDark = () => preference === "dark" || (preference === "system" && query.matches);

function apply() {
  const dark = isDark();
  // brand.ts recolours each theme; this says which one its colours are for.
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  setTheme(dark ? "sap_horizon_dark" : "sap_horizon");
  // The browser's own parts (scrollbars, date pickers, plain inputs) follow too.
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  listeners.forEach((l) => l());
}
apply();
query.addEventListener("change", apply);
window.addEventListener("storage", (e) => {
  if (e.key !== THEME_KEY) return;
  preference = stored();
  apply();
});

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Kept for this page only.
  }
  apply();
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/** What the person picked. */
export const useThemePreference = () => useSyncExternalStore(subscribe, () => preference);

/** Whether the page is dark now, for what UI5 doesn't draw (the lineage picture, charts). */
export const useDarkMode = () => useSyncExternalStore(subscribe, isDark);
