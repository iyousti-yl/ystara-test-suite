/**
 * The youlytics brand on top of SAP's Horizon themes: one layer that every
 * page and UI5 control gets its colours, fonts and corners from.
 *
 * UI5 draws with its theme parameters (--sap... CSS variables), and a theme
 * gives each one a literal value (no parameter refers to another). So the
 * brand takes each theme's parameters, swaps every SAP colour for its brand
 * colour (COLOURS: the blues for sapphire, the greens too since the brand has
 * no green, the reds for ruby, the oranges for amber, the greys and the
 * text for mist, ink and their shades), then sets the parameters that need a
 * decision rather than a swap (ROLES: the one amber primary button, the calm
 * status tags). The result is injected as a stylesheet that outranks UI5's
 * own (`:root:root`), for light and dark alike.
 *
 * The dark colours are derived from the brand, which defines light only.
 * Decorative palettes no page uses (charts, avatars, tile categories) are left
 * as SAP made them.
 */
import light from "@ui5/webcomponents-theming/dist/generated/themes/sap_horizon/parameters-bundle.css.js";
import dark from "@ui5/webcomponents-theming/dist/generated/themes/sap_horizon_dark/parameters-bundle.css.js";

/** The guide's colours. Amber is a fill, never text on a light ground; ruby is only for failures, risks and drops. */
export const BRAND = {
  sapphire: "#1F3B70",
  ink: "#142033",
  amethyst: "#5E4E8C",
  amber: "#D9962B",
  ruby: "#9E2B3F",
  mist: "#F4F6FA",
  grey: "#8A96A8",
  /** On sapphire: small amber text, and secondary text. */
  amberOnSapphire: "#E9B35A",
  secondaryOnSapphire: "#C9D4E8",
} as const;

/** Text that reads on mist and white (5.4:1 and 5.8:1), for descriptions and captions. */
const MUTED = "#5B6678";

/** The same roles in dark mode: on the ground #0F1A2E and cards #17243D, each passes 4.5:1. */
export const DARK = {
  ground: "#0F1A2E",
  card: "#17243D",
  text: "#E6ECF5",
  muted: "#A9B6CC",
  sapphire: "#8FB0E8",
  amethyst: "#B3A6E0",
  ruby: "#E8899A",
  amber: BRAND.amber,
  grey: "#6E7C94",
  border: "#2A3A57",
} as const;

type Theme = "light" | "dark";

/** Parameters of decorative palettes, left as they are. */
const DECORATIVE = /Chart|Legend|Shell_Category|Avatar_|IndicationColor|Illustrative|AccentColor|AccentBackground|Assistant/;

/** SAP colour (lower case, as the themes write them) → brand colour. `rgb:` keys match rgba() by their red, green and blue. */
const COLOURS: Record<Theme, Record<string, string>> = {
  light: {
    // Brand blues, links, selection, focus, information → sapphire and its tints.
    "#0070f2": BRAND.sapphire,
    "#0064d9": BRAND.sapphire,
    "#0057d2": BRAND.sapphire,
    "#0032a5": BRAND.sapphire,
    "#0040b0": "#12244A",
    "#002a86": BRAND.ink,
    "#e8f3ff": "#EEF2F8",
    "#ebf8ff": "#EEF2F8",
    "#edf6ff": "#EEF2F8",
    "#e1f4ff": "#EEF2F8",
    "#e3f0ff": "#E4EAF4",
    "#d4e8ff": "#E4EAF4",
    "#d9ecff": "#E4EAF4",
    "#d1efff": "#E4EAF4",
    "#d9ebff": "#E4EAF4",
    "#b5d8ff": "#B9C6DE",
    "#b0d5ff": "#B9C6DE",
    "#7bcfff": "#B9C6DE",
    "#dcf3ff": "#E4EAF4",
    "#cdedff": "#E4EAF4",
    "#a6cfff": "#C9D4E8",
    "#003e87": BRAND.sapphire,
    "#0058c0": "#182F5A",
    "rgb:104,174,255": "31,59,112",
    "rgb:79,160,255": "31,59,112",
    // Text, labels, greys, grounds and borders → ink, muted, grey, mist.
    "#131e29": BRAND.ink,
    "#1d2d3e": BRAND.ink,
    "#223548": BRAND.ink,
    "rgb:34,53,72": "20,32,51",
    "#556b82": MUTED,
    "#556b81": MUTED,
    "#5b738b": MUTED,
    "rgb:85,107,129": "91,102,120",
    "#758ca4": BRAND.grey,
    "#788fa6": BRAND.grey,
    "#f5f6f7": BRAND.mist,
    "#eff1f2": BRAND.mist,
    "#edf0f3": "#EEF2F8",
    "#eaecee": "#EBEFF5",
    "#dee2e5": "#DDE3EC",
    "#d5dadd": "#DDE3EC",
    "#d9d9d9": "#E3E8F0",
    "#a8b2bd": "#C9D1DE",
    "#bcc3ca": "#C9D1DE",
    // Errors → ruby.
    "#aa0808": BRAND.ruby,
    "#e90b0b": BRAND.ruby,
    "#f53232": BRAND.ruby,
    "#d20a0a": BRAND.ruby,
    "#aa2608": BRAND.ruby,
    "#840606": "#85233A",
    "#ffeaf4": "#F8ECEF",
    "#ffbddb": "#F0D5DB",
    "#fcc4c4": "#F0D5DB",
    "#fb9d9d": "#E3BCC4",
    "#ff8ec4": "#E3BCC4",
    "rgb:255,142,196": "158,43,63",
    // Success: the brand has no green, so done is sapphire too (with its check mark).
    "#256f3a": BRAND.sapphire,
    "#30914c": BRAND.sapphire,
    "#188918": BRAND.sapphire,
    "#2c8646": "#182F5A",
    "#1e592f": BRAND.ink,
    "#f5fae5": "#EEF2F8",
    "#ebf5cb": "#E4EAF4",
    "#e3f1b6": "#E4EAF4",
    "#bae8bc": "#D5DEED",
    "#dbeda0": "#C9D4E8",
    "#cee67e": "#B9C6DE",
    "#e5f2ba": "#E4EAF4",
    "rgb:48,145,76": "31,59,112",
    // Warnings → amber as a fill, a dark amber where it is text.
    "#e76500": BRAND.amber,
    "#dd6100": BRAND.amber,
    "#e26300": BRAND.amber,
    "#d27700": BRAND.amber,
    "#b44f00": "#7F5310",
    "#b95100": "#7F5310",
    "#fff8d6": "#FBF3E4",
    "#ffef9e": "#F6E6C6",
    "#ffdfc3": "#F6E6C6",
    "#fff3b8": "#F6E6C6",
    "#fff3b7": "#FBF3E4",
    "#fff4bd": "#F6E6C6",
    "#ffeb84": "#EFD3A0",
    "#ffe770": "#EFD3A0",
    "rgb:255,213,10": "217,150,43",
    // Markers and accents → amethyst.
    "#5d36ff": BRAND.amethyst,
    "#a100c2": BRAND.amethyst,
    "#8b47d7": BRAND.amethyst,
    "#7800a4": BRAND.amethyst,
    "#046c7a": BRAND.amethyst,
    "#07838f": BRAND.amethyst,
    "#e2dbff": "#E4E0EE",
    "#ded3ff": "#E4E0EE",
    "#ddccf0": "#E4E0EE",
    "#c2fcee": "#E4E0EE",
  },
  dark: {
    "#12171c": DARK.ground,
    "#1d232a": DARK.card,
    "#1c242c": DARK.card,
    "#161c22": "#13203A",
    "#242e38": "#1A2843",
    "#222b35": "#1D2C48",
    "#213131": "#0B1424",
    "#020303": "#0B1424",
    "#101418": "#0B1424",
    "#2e3742": DARK.border,
    "#475566": DARK.border,
    "#2e3b48": DARK.border,
    "#45617c": DARK.border,
    "#3a4a5a": "#3A4D6E",
    "#768ea5": "#3A4D6E",
    "#00457b": "#3A4D6E",
    "#647891": "#4A5D7E",
    "#74879f": "#4A5D7E",
    "#f5f6f7": DARK.text,
    "#d5dadd": "#C9D4E8",
    "#bde2ff": "#C9D4E8",
    "#a5cfff": "#C9D4E8",
    "#a9b4be": DARK.muted,
    "#8396a8": DARK.muted,
    "#b8c1c9": DARK.muted,
    "rgb:169,180,190": "169,182,204",
    "rgb:245,246,247": "230,236,245",
    "rgb:29,35,42": "23,36,61",
    // Blues → light sapphire, and its deep tints for selected and information grounds.
    "#0070f2": DARK.sapphire,
    "#0064d9": "#7A9DDA",
    "#0057d2": DARK.sapphire,
    "#4db1ff": DARK.sapphire,
    "#008fff": DARK.sapphire,
    "#67bcff": DARK.sapphire,
    "#005394": DARK.sapphire,
    "#9ad3ff": DARK.sapphire,
    "#002b4d": "#22355A",
    "#003967": "#22355A",
    "#002643": "#1C2E4F",
    "#0034bf": "#2F4F8A",
    "#246c37": "#2F4F8A",
    "#00144a": "#1C2E4F",
    "#001b64": "#1C2E4F",
    "rgb:77,177,255": "143,176,232",
    "rgb:0,38,67": "28,46,79",
    // Success, without green.
    "#6dad1f": DARK.sapphire,
    "#97dd40": DARK.sapphire,
    "#7bc323": DARK.sapphire,
    "#5dc122": DARK.sapphire,
    "#1b512a": "#1C2E4F",
    "#153e20": "#1C2E4F",
    "#174624": "#1C2E4F",
    "#11331a": "#1C2E4F",
    "rgb:109,173,31": "143,176,232",
    // Errors → light ruby on deep ruby.
    "#fa6161": DARK.ruby,
    "#fb7a7a": DARK.ruby,
    "#ff8cb2": DARK.ruby,
    "#620000": "#4A1E2A",
    "#910000": "#6B2B3C",
    "#490000": "#4A1E2A",
    "#680000": "#4A1E2A",
    "#350000": "#3A1A24",
    "rgb:248,38,38": "232,137,154",
    // Warnings → amber.
    "#f7bf00": BRAND.amberOnSapphire,
    "#ffdf72": BRAND.amberOnSapphire,
    "#ffcf2b": BRAND.amberOnSapphire,
    "#523900": "#5A4519",
    "#845c00": "#6B5221",
    "#6b4b00": "#5A4519",
    "#382700": "#3A2C12",
    "rgb:132,92,0": "233,179,90",
    // Markers → amethyst.
    "#64edd2": DARK.amethyst,
    "#d3b6ff": DARK.amethyst,
  },
};

/** Status tags, in calm tints: done in sapphire, running in amethyst, failed in ruby, warnings on amber with ink text. */
function tag(prefix: string, background: string, border: string, text: string, hover: string): Record<string, string> {
  return {
    [`--sapButton_${prefix}_Background`]: background,
    [`--sapButton_${prefix}_BorderColor`]: border,
    [`--sapButton_${prefix}_TextColor`]: text,
    [`--sapButton_${prefix}_Hover_Background`]: hover,
    [`--sapButton_${prefix}_Hover_BorderColor`]: border,
    [`--sapButton_${prefix}_Hover_TextColor`]: text,
  };
}

/** The avatar of the user menu and its accounts (UI5's Accent6, which every avatar takes unless told otherwise): sapphire. */
function avatar(background: string, text: string): Record<string, string> {
  return {
    "--sapAvatar_6_Background": background,
    "--sapAvatar_6_BorderColor": background,
    "--sapAvatar_6_TextColor": text,
  };
}

/** The one primary action of a view: amber with ink text, never white (2.5:1). */
function primary(hover: string, active: string): Record<string, string> {
  return {
    "--sapButton_Emphasized_Background": BRAND.amber,
    "--sapButton_Emphasized_BorderColor": BRAND.amber,
    "--sapButton_Emphasized_TextColor": BRAND.ink,
    "--sapButton_Emphasized_Hover_Background": hover,
    "--sapButton_Emphasized_Hover_BorderColor": hover,
    "--sapButton_Emphasized_Hover_TextColor": BRAND.ink,
    "--sapButton_Emphasized_Active_Background": active,
    "--sapButton_Emphasized_Active_BorderColor": active,
    "--sapButton_Emphasized_Active_TextColor": BRAND.ink,
  };
}

const ROLES: Record<Theme, Record<string, string>> = {
  light: {
    ...primary("#C8871F", "#B47719"),
    ...tag("Success", "#E4EAF4", "#B9C6DE", BRAND.sapphire, "#D5DEED"),
    ...tag("Information", "#EEECF4", "#CFC8E0", BRAND.amethyst, "#E4E0EE"),
    ...tag("Negative", "#F8ECEF", "#E3BCC4", BRAND.ruby, "#F0D5DB"),
    ...tag("Critical", "#FBF3E4", "#EFD3A0", BRAND.ink, "#F6E6C6"),
    ...avatar("#E4EAF4", BRAND.sapphire),
    "--sapContent_DisabledOpacity": "0.5",
    // Brand tokens for what UI5 doesn't draw (app.css, the lineage picture).
    "--ystara-sapphire": BRAND.sapphire,
    "--ystara-amethyst": BRAND.amethyst,
    "--ystara-amber": BRAND.amber,
    "--ystara-ruby": BRAND.ruby,
    "--ystara-grey": BRAND.grey,
    "--ystara-ink": BRAND.ink,
    "--ystara-muted": MUTED,
    "--ystara-card": "#fff",
    "--ystara-border": "#E3E8F0",
    "--ystara-tint": "#EEF2F8",
  },
  dark: {
    ...primary("#E3A845", "#C8871F"),
    ...tag("Success", "#1F3B70", "#2F4F8A", "#C9D4E8", "#264680"),
    ...tag("Information", "#2A2546", "#4A4275", DARK.amethyst, "#332D55"),
    ...tag("Negative", "#3A1A24", "#6B2B3C", DARK.ruby, "#47202C"),
    ...tag("Critical", "#3A2C12", "#6B5221", BRAND.amberOnSapphire, "#45351A"),
    ...avatar(BRAND.sapphire, "#C9D4E8"),
    "--sapContent_DisabledOpacity": "0.5",
    "--ystara-sapphire": DARK.sapphire,
    "--ystara-amethyst": DARK.amethyst,
    "--ystara-amber": DARK.amber,
    "--ystara-ruby": DARK.ruby,
    "--ystara-grey": DARK.grey,
    "--ystara-ink": DARK.text,
    "--ystara-muted": DARK.muted,
    "--ystara-card": DARK.card,
    "--ystara-border": DARK.border,
    "--ystara-tint": "#1C2E4F",
  },
};

const SANS = '"IBM Plex Sans", Arial, Helvetica, sans-serif';
/** Plex Sans at 600 and 500 under names of their own (fonts.ts): UI5 asks for its bold parts by family, not by weight. */
const SEMIBOLD = `"Ystara Plex Semibold", ${SANS}`;
const MEDIUM = `"Ystara Plex Medium", ${SANS}`;
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

/** Type, corners and sizes, the same in both themes. Sizes follow the guide: body 16px, headings 34 and 22px. */
const SHARED: Record<string, string> = {
  "--sapFontFamily": SANS,
  "--sapFontLightFamily": SANS,
  "--sapFontBoldFamily": SEMIBOLD,
  "--sapFontSemiboldFamily": SEMIBOLD,
  "--sapFontSemiboldDuplexFamily": SEMIBOLD,
  "--sapFontBlackFamily": SEMIBOLD,
  "--sapFontHeaderFamily": SEMIBOLD,
  "--sapButton_FontFamily": MEDIUM,
  "--sapButton_Emphasized_FontFamily": SEMIBOLD,
  "--sapButton_Emphasized_FontWeight": "normal",
  "--sapObjectHeader_Title_FontFamily": SEMIBOLD,
  "--sapContent_MonospaceFontFamily": MONO,
  "--sapContent_MonospaceBoldFontFamily": `"Ystara Plex Mono Semibold", ${MONO}`,
  "--sapFontSize": "1rem",
  "--sapFontSmallSize": ".875rem",
  "--sapFontLargeSize": "1.125rem",
  "--sapFontHeader1Size": "3.5rem",
  "--sapFontHeader2Size": "2.125rem",
  "--sapFontHeader3Size": "1.375rem",
  "--sapFontHeader4Size": "1.375rem",
  "--sapFontHeader5Size": "1rem",
  "--sapFontHeader6Size": ".875rem",
  // Buttons and fields 40px high, so a line of controls is one height.
  "--sapElement_Height": "2.5rem",
  "--sapElement_BorderCornerRadius": ".625rem",
  "--sapButton_BorderCornerRadius": ".625rem",
  "--sapButton_Segment_BorderCornerRadius": ".625rem",
  "--sapField_BorderCornerRadius": ".625rem",
  "--sapGroup_BorderCornerRadius": ".75rem",
  "--sapPopover_BorderCornerRadius": ".75rem",
  "--sapTile_BorderCornerRadius": ".75rem",
  "--ystara-mono": MONO,
};

const PARAMETER = /(--sap[A-Za-z0-9_]+):\s*([^;]+);/g;
const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi;

/** A value with each SAP colour in `map` swapped for its brand colour. */
export function recolour(value: string, map: Record<string, string>): string {
  return value.replace(COLOUR, (match, r?: string, g?: string, b?: string) => {
    if (r === undefined) return map[match.toLowerCase()] ?? match;
    const to = map[`rgb:${r},${g},${b}`];
    return to ? match.replace(/\(.*/, `(${to}`) : match;
  });
}

/** The theme's parameters whose value the brand changes, recoloured, with ROLES on top. */
export function brandParameters(themeCss: string, theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of themeCss.matchAll(PARAMETER)) {
    if (DECORATIVE.test(name)) continue;
    const next = recolour(value, COLOURS[theme]);
    if (next !== value) out[name] = next;
  }
  return { ...out, ...ROLES[theme] };
}

const block = (selector: string, parameters: Record<string, string>) =>
  `${selector}{${Object.entries(parameters)
    .map(([name, value]) => `${name}:${value}`)
    .join(";")}}`;

/**
 * The brand stylesheet. UI5 adds its theme's parameters to the page as `:root`
 * rules; these outrank them. theme.ts marks the page `data-theme="dark"` when
 * it is dark.
 */
export function brandCss(): string {
  return [
    block(":root:root", SHARED),
    block(':root:root:not([data-theme="dark"])', brandParameters(light, "light")),
    block(':root:root[data-theme="dark"]', brandParameters(dark, "dark")),
  ].join("\n");
}

/** Adds the brand stylesheet to the page (main.tsx, before the app draws). */
export function applyBrand() {
  const style = document.createElement("style");
  style.dataset.ystara = "brand";
  style.textContent = brandCss();
  document.head.append(style);
}
