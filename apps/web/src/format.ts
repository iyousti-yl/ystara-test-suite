/**
 * The locale of every date and number the app writes: English, like the rest
 * of the app, in the browser's region ("en-BE" for a browser set to nl-BE or
 * fr-BE), so a Belgian reads "22 Oct 2026, 15:37" and "1.234,5" instead of
 * Dutch month names among English words. A region English has no data for
 * falls back to plain English.
 */
export function appLocale(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages): string {
  for (const tag of languages) {
    try {
      const locale = new Intl.Locale(tag);
      const region = locale.region ?? (locale.language === "en" ? undefined : locale.maximize().region);
      if (region) return Intl.DateTimeFormat.supportedLocalesOf(`en-${region}`)[0] ?? "en";
    } catch {
      // Not a valid language tag: try the next one.
    }
  }
  return "en";
}

const locale = appLocale();
const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

/** "15 Oct 2026, 21:30" in English with the browser's region, or a dash. */
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : "–");

const dateTimeSeconds = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });

/**
 * formatDateTime for times shown side by side (snapshots in a list): to the
 * second for those that share their minute with another, so two taken one
 * after the other don't look the same.
 */
export function formatDateTimesApart(isos: (string | null | undefined)[]): (iso: string | null | undefined) => string {
  const perMinute = new Map<string, number>();
  for (const iso of new Set(isos)) if (iso) perMinute.set(formatDateTime(iso), (perMinute.get(formatDateTime(iso)) ?? 0) + 1);
  return (iso) => (iso && (perMinute.get(formatDateTime(iso)) ?? 0) > 1 ? dateTimeSeconds.format(new Date(iso)) : formatDateTime(iso));
}

const number = new Intl.NumberFormat(locale);

/** "1,234" (or "1.234") in the app's locale, or a dash. */
export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? "–" : number.format(n));

/** "1 scan", "3 scans", "1,204 scans": English plurals with an s. */
export const counted = (n: number, what: string) => `${formatNumber(n)} ${what}${n === 1 ? "" : "s"}`;

/** A list's heading: "12 snapshots", or "Latest 50 snapshots" while older ones are left to load (Show older). */
export const countedLatest = (n: number, more: boolean, what: string) => (more ? `Latest ${formatNumber(n)} ${what}s` : counted(n, what));

/** A count that may stop at a page of the list: "50 or more scans" when older ones weren't loaded. */
export const countedAtLeast = (n: number, more: boolean, what: string) => (more ? `${formatNumber(n)} or more ${what}s` : counted(n, what));

const seconds = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A duration in milliseconds as seconds: "1.2 s" (or "1,2 s"), or a dash. */
export const formatSeconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? "–" : `${seconds.format(ms / 1000)} s`);

/** A percentage the person set or reads as a number: "25 %", with a space, as formatDifference writes it. */
export const formatPercent = (n: number) => `${number.format(n)} %`;

const decimalSeparator = number.formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";

/** An exact decimal from the API ("-1234.50") in the app's locale, digit for digit ("-1,234.50"), or a dash. */
export function formatExact(text: string | null | undefined): string {
  if (text === null || text === undefined) return "–";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  return m ? `${m[1]}${number.format(BigInt(m[2]))}${m[3] ? decimalSeparator + m[3] : ""}` : text;
}

const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "exceptZero" });

/** A difference with its sign and, when known, its percentage: "+20 (+25 %)". `difference` is a number or exact decimal text. */
export function formatDifference(difference: number | string, pct: number | null): string {
  const text = typeof difference === "number" ? formatNumber(difference) : formatExact(difference);
  const signed = /^-|^0$|^0[.,]0*$/.test(typeof difference === "number" ? String(difference) : difference) ? text : `+${text}`;
  return pct === null ? signed : `${signed} (${percent.format(pct)} %)`;
}

const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 hours ago", "yesterday", "in 2 days": for lists, with the exact time (formatDateTime) on hover. "just now" under a minute. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const ms = new Date(iso).getTime() - now;
  for (const [unit, size] of UNITS) if (Math.abs(ms) >= size) return relative.format(Math.round(ms / size), unit);
  return "just now";
}
