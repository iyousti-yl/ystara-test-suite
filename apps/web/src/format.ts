const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "15 Oct 2026, 21:30" in the browser's locale, or a dash. */
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : "–");

const dateTimeSeconds = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

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

const number = new Intl.NumberFormat();

/** "1,234" in the browser's locale, or a dash. */
export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? "–" : number.format(n));

/** "1 scan", "3 scans": English plurals with an s. */
export const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

const decimalSeparator = number.formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";

/** An exact decimal from the API ("-1234.50") in the browser's locale, digit for digit ("-1,234.50"), or a dash. */
export function formatExact(text: string | null | undefined): string {
  if (text === null || text === undefined) return "–";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  return m ? `${m[1]}${number.format(BigInt(m[2]))}${m[3] ? decimalSeparator + m[3] : ""}` : text;
}

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, signDisplay: "exceptZero" });

/** A difference with its sign and, when known, its percentage: "+20 (+25 %)". `difference` is a number or exact decimal text. */
export function formatDifference(difference: number | string, pct: number | null): string {
  const text = typeof difference === "number" ? formatNumber(difference) : formatExact(difference);
  const signed = /^-|^0$|^0[.,]0*$/.test(typeof difference === "number" ? String(difference) : difference) ? text : `+${text}`;
  return pct === null ? signed : `${signed} (${percent.format(pct)} %)`;
}
