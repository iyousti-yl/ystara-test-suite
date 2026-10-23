import { describe, expect, it } from "vitest";
import { HEALTH_STATES, pipelineHealth, type PipelineSummary } from "./health.js";

const at = new Date("2026-10-20T08:00:00Z");
const suite = (status: NonNullable<PipelineSummary["suite"]>["status"], passed: number | null, total: number | null, cause: "manual" | "scan" = "manual") =>
  ({ id: "su1", cause, status, requestedAt: at, finishedAt: at, passed, total }) as const;
const snapshot = (status: NonNullable<PipelineSummary["snapshot"]>["status"], alert: NonNullable<PipelineSummary["snapshot"]>["alert"] = null, outputRows = 10) =>
  ({ id: "sn1", status, scheduled: true, requestedAt: at, finishedAt: at, outputRows, alert }) as const;

describe("pipelineHealth", () => {
  it("puts failing scenarios first, with how many and the run to open", () => {
    expect(pipelineHealth({ scenarios: 3, suite: suite("failed", 1, 3, "scan"), snapshot: snapshot("succeeded") })).toEqual({
      state: "failing",
      sentence: "2 of 3 scenarios fail after a scan changed the pipeline.",
      next: { page: "suite", id: "su1", text: "See which checks broke" },
    });
    expect(pipelineHealth({ scenarios: 1, suite: suite("failed", 0, 1), snapshot: null }).sentence).toBe("Its one scenario fails.");
    expect(pipelineHealth({ scenarios: 1, suite: suite("error", null, 1), snapshot: null }).sentence).toBe("The latest run of all scenarios couldn't run.");
  });

  it("then a failed snapshot, then a snapshot's alert, in the alert's own words", () => {
    expect(pipelineHealth({ scenarios: 0, suite: null, snapshot: snapshot("failed") })).toMatchObject({ state: "failing", next: { page: "snapshot", id: "sn1" } });
    const dropped = snapshot("succeeded", [{ kind: "output_dropped", step: "V_OUT", rowsBefore: 100, rowsAfter: 70, percent: 30, threshold: 20 }]);
    expect(pipelineHealth({ scenarios: 1, suite: suite("passed", 1, 1), snapshot: dropped })).toEqual({
      state: "changed",
      sentence: "The output V_OUT lost 30% of its rows: 100 before, 70 now. Alerts start above 20%.",
      next: { page: "compare", text: "Compare the latest snapshots" },
    });
  });

  it("then an output without rows, even when the scenarios pass", () => {
    expect(pipelineHealth({ scenarios: 2, suite: suite("passed", 2, 2), snapshot: snapshot("succeeded", null, 0) })).toEqual({
      state: "empty",
      sentence: "The latest snapshot found no rows in the output.",
      next: { page: "snapshot", id: "sn1", text: "Open the snapshot" },
    });
  });

  it("says when something runs, when all is well, and what to start with", () => {
    expect(pipelineHealth({ scenarios: 2, suite: suite("running", null, 2), snapshot: null }).state).toBe("running");
    expect(pipelineHealth({ scenarios: 2, suite: suite("passed", 2, 2), snapshot: null })).toEqual({ state: "ok", sentence: "Both its scenarios pass.", next: null });
    expect(pipelineHealth({ scenarios: 5, suite: suite("passed", 5, 5), snapshot: null }).sentence).toBe("All 5 scenarios pass.");
    expect(pipelineHealth({ scenarios: 1, suite: null, snapshot: null }).sentence).toBe("Its one scenario hasn't run with Run all yet.");
    expect(pipelineHealth({ scenarios: 0, suite: null, snapshot: snapshot("succeeded") })).toMatchObject({ state: "ok", next: { page: "scenarios", text: "Write a scenario" } });
    expect(pipelineHealth({ scenarios: 0, suite: null, snapshot: null })).toMatchObject({ state: "untested", next: { text: "Write a scenario" } });
    expect(pipelineHealth({ scenarios: 2, suite: null, snapshot: null })).toMatchObject({ state: "untested", next: { text: "Run all scenarios" } });
  });

  it("orders the states most pressing first", () => {
    expect(HEALTH_STATES).toEqual(["failing", "changed", "empty", "untested", "running", "ok"]);
  });
});
