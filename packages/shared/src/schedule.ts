import cronParser from "cron-parser";

/**
 * Snapshot schedules: a cron line per pipeline, with five fields (minute,
 * hour, day of the month, month, weekday), read in an IANA time zone such as
 * Europe/Brussels. The API checks a schedule before storing it, the web app
 * shows the same check while one is typed, and the worker works out each next
 * run with nextRun.
 *
 * Daylight saving (cron-parser's handling): a run that falls in the hour the
 * clock skips runs at the same minute of the next hour, and a run in the hour
 * that repeats runs once.
 */

/** Runs closer together than this are refused: each one reads every measurable step in the tenant's database. */
export const MIN_MINUTES_BETWEEN_RUNS = 15;

/** A pipeline's schedule (migration 008). */
export interface PipelineSchedule {
  pipelineId: string;
  cron: string;
  timeZone: string;
  nextRunAt: Date;
  /** An alert when the output loses more than this share of its rows (percent, 1 to 100). */
  rowDropPercent: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export type ScheduleCheck = { ok: true; cron: string; next: Date[] } | { ok: false; error: string };

export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return name.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Whether a cron line and time zone make a schedule Ystara runs, and if so the
 * cron line as stored (single spaces) and its next `count` runs after `from`.
 * The error is a sentence for the person who typed it.
 */
export function checkSchedule(cron: string, timeZone: string, from = new Date(), count = 5): ScheduleCheck {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return { ok: false, error: 'A schedule has five fields: minute, hour, day of the month, month and weekday, as in "30 7 * * 1-5".' };
  }
  if (!isTimeZone(timeZone)) return { ok: false, error: `"${timeZone}" is not a time zone. Use a name such as Europe/Brussels.` };
  const line = fields.join(" ");
  let runs: Date[];
  try {
    runs = upcoming(line, timeZone, from, 50);
  } catch (e) {
    return { ok: false, error: `This is not a cron line Ystara can read: ${e instanceof Error ? e.message : String(e)}.` };
  }
  if (runs.length === 0) return { ok: false, error: "This schedule never runs: no date matches it." };
  // The next 50 runs show any pattern within a day or a week.
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_MINUTES_BETWEEN_RUNS * 60_000) {
      return {
        ok: false,
        error: `Runs must be at least ${MIN_MINUTES_BETWEEN_RUNS} minutes apart, and this schedule runs at ${describeRun(runs[i - 1], timeZone)} and ${describeRun(runs[i], timeZone)}.`,
      };
    }
  }
  return { ok: true, cron: line, next: runs.slice(0, count) };
}

/** The first run after `after`, for a schedule that checkSchedule accepted. */
export function nextRun(cron: string, timeZone: string, after: Date): Date {
  const [next] = upcoming(cron, timeZone, after, 1);
  if (!next) throw new Error(`The schedule "${cron}" has no run after ${after.toISOString()}`);
  return next;
}

/** A run as a person reads it in the schedule's time zone: "Mon 20 Oct, 07:30". */
export function describeRun(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

function upcoming(cron: string, timeZone: string, after: Date, count: number): Date[] {
  const it = cronParser.parseExpression(cron, { currentDate: after, tz: timeZone });
  const runs: Date[] = [];
  while (runs.length < count && it.hasNext()) runs.push(it.next().toDate());
  return runs;
}
