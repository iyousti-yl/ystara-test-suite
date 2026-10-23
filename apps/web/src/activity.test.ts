import { ACTIVE_WINDOW_MINUTES } from "@ystara/shared";
import { describe, expect, it } from "vitest";
import { activityTracker, trackActivity } from "./activity";

const minute = 60_000;

describe("whether someone uses the page", () => {
  it("counts opening the page, for the active window", () => {
    const tracker = activityTracker(0);
    expect(tracker.isActive(0)).toBe(true);
    expect(tracker.isActive(ACTIVE_WINDOW_MINUTES * minute - 1)).toBe(true);
    expect(tracker.isActive(ACTIVE_WINDOW_MINUTES * minute)).toBe(false);
  });

  it("starts the window again on each key, click, touch or scroll", () => {
    const tracker = activityTracker(0);
    tracker.note(10 * minute);
    expect(tracker.isActive(12 * minute)).toBe(true);
    expect(tracker.isActive((10 + ACTIVE_WINDOW_MINUTES) * minute)).toBe(false);
  });

  it("hears those on the window, and nothing else", () => {
    const target = new EventTarget();
    const tracker = activityTracker(0);
    trackActivity(target, tracker);
    const later = Date.now() + 1000 * minute;
    expect(tracker.isActive(later)).toBe(false);
    // A poll, a timer or a mouse passing over the page is not use.
    target.dispatchEvent(new Event("mousemove"));
    target.dispatchEvent(new Event("visibilitychange"));
    expect(tracker.isActive(Date.now())).toBe(false);
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      const fresh = activityTracker(0);
      const t = new EventTarget();
      trackActivity(t, fresh);
      t.dispatchEvent(new Event(name));
      expect(fresh.isActive(Date.now())).toBe(true);
    }
  });
});
