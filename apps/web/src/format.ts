const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "15 Oct 2026, 21:30" in the browser's locale, or a dash. */
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : "–");

const number = new Intl.NumberFormat();

/** "1,234" in the browser's locale, or a dash. */
export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? "–" : number.format(n));
