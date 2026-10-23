import { ACTIVE_WINDOW_MINUTES } from "@ystara/shared";

/**
 * Whether someone is using the page: a sign-in ends after IDLE_MINUTES without
 * use, and polling alone (a scan's progress, the board refreshing every minute)
 * mustn't keep it alive. api.ts sends ACTIVITY_HEADER on a call made within
 * ACTIVE_WINDOW_MINUTES of the last key, click, touch or scroll; opening the
 * page counts too. Calls that change something count on the server anyway.
 */
export const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export interface ActivityTracker {
  /** Someone did something at `at`. */
  note: (at?: number) => void;
  /** Whether that was within the active window before `at`. */
  isActive: (at?: number) => boolean;
}

export function activityTracker(openedAt = Date.now()): ActivityTracker {
  let last = openedAt;
  return {
    note: (at = Date.now()) => {
      last = at;
    },
    isActive: (at = Date.now()) => at - last < ACTIVE_WINDOW_MINUTES * 60_000,
  };
}

/** The page's own tracker, which api.ts asks. */
export const activity = activityTracker();

/** Notes every key, click, touch and scroll on `target` (the window): in the capture phase, so nothing on the page can stop one first. */
export function trackActivity(target: Pick<EventTarget, "addEventListener">, tracker: ActivityTracker = activity) {
  for (const name of ACTIVITY_EVENTS) target.addEventListener(name, () => tracker.note(), { capture: true, passive: true });
}
