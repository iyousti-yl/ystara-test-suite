import { describe, expect, it } from "vitest";
import { alertReasons, alertSubject, describeAlertReason, type AlertReason } from "./alerts.js";
import type { ColumnMeasures, SnapshotDetails, SnapshotObject } from "./api.js";

// Synthetic snapshots of a made-up pipeline: LT_RAW --> V_MID --> V_OUT, the output.
const snapshot = (objects: SnapshotObject[], status: SnapshotDetails["status"] = "succeeded"): SnapshotDetails => ({
  id: "snapshot",
  tenantId: "tenant",
  pipelineId: "pipeline",
  pipelineName: "Synthetic",
  scanId: null,
  status,
  scheduled: true,
  alert: null,
  requestedAt: new Date(0),
  startedAt: null,
  finishedAt: null,
  error: null,
  counts: { measured: 0, notMeasurable: 0, failed: 0 },
  objects,
});

const column = (name: string, o: Partial<ColumnMeasures> = {}): ColumnMeasures => ({ name, dataType: "INTEGER", nonNull: 10, distinct: 10, minHash: "a", maxHash: "b", sum: "55", sumHash: null, sumScale: 0, ...o });

const step = (technicalName: string, o: Partial<SnapshotObject> = {}): SnapshotObject => ({
  space: "S",
  technicalName,
  type: "sql_view",
  definitionHash: `def-${technicalName}`,
  status: "measured",
  reason: null,
  rows: 1000,
  columns: [column("ID")],
  tookMs: 5,
  ...o,
});

const flow = step("TF_LOAD", { type: "transformation_flow", status: "not_measurable", reason: "process", rows: null, columns: null });
const pipeline = (o: { out?: Partial<SnapshotObject>; mid?: Partial<SnapshotObject>; flow?: Partial<SnapshotObject> } = {}) => [
  { ...flow, ...o.flow },
  step("V_MID", o.mid),
  step("V_OUT", o.out),
];
const output = { space: "S", technicalName: "V_OUT" };
const reasons = (previous: SnapshotDetails | undefined, current: SnapshotDetails, rowDropPercent = 20) => alertReasons({ previous, current, output, rowDropPercent });

describe("alert reasons", () => {
  it("are none when nothing that alerts changed, even if the data did", () => {
    const changedData = pipeline({ out: { rows: 900, columns: [column("ID", { sum: "99" })] }, mid: { rows: 5000 } });
    expect(reasons(snapshot(pipeline()), snapshot(changedData))).toEqual([]);
  });

  it("report a failed snapshot with its failed steps, with or without an earlier one", () => {
    const failed = snapshot(pipeline({ mid: { status: "failed", reason: "a database error that may quote a value", rows: null, columns: null } }), "failed");
    expect(reasons(undefined, failed)).toEqual([{ kind: "failed", steps: ["V_MID"] }]);
    expect(reasons(undefined, snapshot([], "failed"))).toEqual([{ kind: "failed", steps: [] }]);
  });

  it("report an output that went empty, or lost more than the threshold of its rows", () => {
    expect(reasons(snapshot(pipeline()), snapshot(pipeline({ out: { rows: 0 } })))).toEqual([{ kind: "output_empty", step: "V_OUT", rowsBefore: 1000 }]);
    expect(reasons(snapshot(pipeline()), snapshot(pipeline({ out: { rows: 750 } })))).toEqual([
      { kind: "output_dropped", step: "V_OUT", rowsBefore: 1000, rowsAfter: 750, percent: 25, threshold: 20 },
    ]);
    // Exactly the threshold, a smaller drop, a higher threshold, or an output that was already empty: no alert.
    expect(reasons(snapshot(pipeline()), snapshot(pipeline({ out: { rows: 800 } })))).toEqual([]);
    expect(reasons(snapshot(pipeline()), snapshot(pipeline({ out: { rows: 750 } })), 30)).toEqual([]);
    expect(reasons(snapshot(pipeline({ out: { rows: 0 } })), snapshot(pipeline({ out: { rows: 0 } })))).toEqual([]);
    // Only the output's rows count.
    expect(reasons(snapshot(pipeline()), snapshot(pipeline({ mid: { rows: 0 } })))).toEqual([]);
  });

  it("report changed definitions, of measured and unmeasured steps, and changed columns", () => {
    const after = pipeline({
      flow: { definitionHash: "def-TF_LOAD-2" },
      out: { definitionHash: "def-V_OUT-2", columns: [column("ID", { dataType: "BIGINT" }), column("NEW_COLUMN")] },
      mid: { columns: [] },
    });
    expect(reasons(snapshot(pipeline()), snapshot(after))).toEqual([
      { kind: "definition_changed", steps: ["V_OUT", "TF_LOAD"] },
      {
        kind: "columns_changed",
        steps: [
          { step: "V_MID", added: [], removed: ["ID"], retyped: [] },
          { step: "V_OUT", added: ["NEW_COLUMN"], removed: [], retyped: ["ID"] },
        ],
      },
    ]);
  });

  it("report steps added to or removed from the pipeline", () => {
    const after = [step("V_MID"), step("V_NEW"), step("V_OUT")];
    expect(reasons(snapshot(pipeline()), snapshot(after))).toEqual([{ kind: "steps_changed", added: ["V_NEW"], removed: ["TF_LOAD"] }]);
  });

  it("put the most pressing first: a failure, then the output", () => {
    const after = snapshot(pipeline({ out: { rows: 0, definitionHash: "x" }, mid: { status: "failed", reason: "x", rows: null, columns: null } }), "failed");
    expect(reasons(snapshot(pipeline()), after).map((r) => r.kind)).toEqual(["failed", "output_empty", "definition_changed"]);
  });
});

describe("alert wording", () => {
  const sentences: [AlertReason, string][] = [
    [{ kind: "failed", steps: ["V_MID"] }, "The snapshot failed. Failed steps: V_MID."],
    [{ kind: "failed", steps: [] }, "The snapshot failed before it measured any step."],
    [{ kind: "output_empty", step: "V_OUT", rowsBefore: 12500 }, "The output V_OUT is empty. It had 12,500 rows in the snapshot before."],
    [
      { kind: "output_dropped", step: "V_OUT", rowsBefore: 12500, rowsAfter: 9000, percent: 28, threshold: 20 },
      "The output V_OUT lost 28% of its rows: 12,500 before, 9,000 now. Alerts start above 20%.",
    ],
    [{ kind: "definition_changed", steps: ["V_OUT"] }, "The definition of V_OUT changed."],
    [{ kind: "definition_changed", steps: ["V_OUT", "TF_LOAD"] }, "The definitions of V_OUT, TF_LOAD changed."],
    [
      { kind: "columns_changed", steps: [{ step: "V_OUT", added: ["A", "B"], removed: ["C"], retyped: ["D"] }] },
      "Columns changed in V_OUT: added A, B; removed C; another type for D.",
    ],
    [{ kind: "steps_changed", added: ["V_NEW"], removed: [] }, "The pipeline's steps changed: added V_NEW."],
  ];
  it.each(sentences)("%o reads as a sentence", (reason, sentence) => expect(describeAlertReason(reason)).toBe(sentence));

  it("names the most pressing reason in the subject", () => {
    expect(alertSubject("Synthetic", [{ kind: "output_dropped", step: "V_OUT", rowsBefore: 10, rowsAfter: 5, percent: 50, threshold: 20 }])).toBe(
      "[Ystara] Output down 50%: Synthetic",
    );
    expect(alertSubject("Synthetic", [{ kind: "failed", steps: [] }, { kind: "output_empty", step: "V_OUT", rowsBefore: 1 }])).toBe("[Ystara] Snapshot failed: Synthetic");
  });
});
