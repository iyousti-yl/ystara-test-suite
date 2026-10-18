import { describe, expect, it } from "vitest";
import type { ColumnMeasures, SnapshotDetails, SnapshotObject } from "./api.js";
import { atScale, compareSnapshots, formatDecimal, parseDecimal } from "./compare.js";

// Synthetic snapshots: one space, made-up views and figures.
const snapshot = (id: string, objects: SnapshotObject[]): SnapshotDetails => ({
  id,
  tenantId: "tenant",
  pipelineId: "pipeline",
  pipelineName: "Synthetic",
  scanId: null,
  status: "succeeded",
  scheduled: false,
  alert: null,
  requestedAt: new Date(0),
  startedAt: null,
  finishedAt: null,
  error: null,
  counts: { measured: 0, notMeasurable: 0, failed: 0 },
  objects,
});

const step = (technicalName: string, o: Partial<SnapshotObject> = {}): SnapshotObject => ({
  space: "SALES",
  technicalName,
  type: "sql_view",
  definitionHash: `def-${technicalName}`,
  status: "measured",
  reason: null,
  rows: 1000,
  columns: [id(), amount("1234.50")],
  tookMs: 5,
  ...o,
});

const id = (o: Partial<ColumnMeasures> = {}): ColumnMeasures => ({ name: "ID", dataType: "INTEGER", nonNull: 1000, distinct: 1000, minHash: "1".repeat(64), maxHash: "2".repeat(64), sum: "500500", sumHash: null, sumScale: 0, ...o });
const amount = (sum: string, o: Partial<ColumnMeasures> = {}): ColumnMeasures => ({
  name: "AMOUNT",
  dataType: "DECIMAL",
  nonNull: 990,
  distinct: 400,
  minHash: "3".repeat(64),
  maxHash: "4".repeat(64),
  sum,
  sumHash: null,
  sumScale: 2,
  ...o,
});

const compare = (before: SnapshotObject[], after: SnapshotObject[]) => compareSnapshots(snapshot("before", before), snapshot("after", after));

describe("comparing two snapshots", () => {
  it("finds nothing when nothing changed", () => {
    const c = compare([step("V_OUT")], [step("V_OUT")]);
    expect(c.verdict).toBe("unchanged");
    expect(c.compared).toHaveLength(1);
    expect(c.compared[0]).toMatchObject({ verdict: "unchanged", definitionChanged: false, rows: { before: 1000, after: 1000, difference: 0, percent: 0 }, columnsAdded: [], columnsRemoved: [] });
    expect(c.compared[0].columns.every((col) => !col.changed)).toBe(true);
    expect(c.before.id).toBe("before");
    expect(c.after).not.toHaveProperty("objects");
  });

  it("sees changed rows, counts, sums and hashes as changed data", () => {
    const after = step("V_OUT", { rows: 1250, columns: [id({ nonNull: 1250, distinct: 1250, maxHash: "5".repeat(64), sum: "781875" }), amount("1534.75", { nonNull: 1240 })] });
    const c = compare([step("V_OUT")], [after]);
    expect(c.verdict).toBe("data_changed");
    const o = c.compared[0];
    expect(o.verdict).toBe("data_changed");
    expect(o.rows).toEqual({ before: 1000, after: 1250, difference: 250, percent: 25 });
    const [idColumn, amountColumn] = o.columns;
    expect(idColumn).toMatchObject({ changed: true, min: "unchanged", max: "changed", distinct: { difference: 250 }, sum: { before: "500500", after: "781875", difference: "281375", changed: true } });
    expect(amountColumn.sum).toMatchObject({ before: "1234.50", after: "1534.75", difference: "300.25", changed: true });
    expect(amountColumn.sum?.percent).toBeCloseTo(24.32, 2);
  });

  it("sees a column added or removed as changed data", () => {
    const region: ColumnMeasures = { name: "REGION", dataType: "NVARCHAR", nonNull: 1000, distinct: 4, minHash: "6".repeat(64), maxHash: "7".repeat(64) };
    const added = compare([step("V_OUT")], [step("V_OUT", { columns: [id(), amount("1234.50"), region] })]);
    expect(added.compared[0]).toMatchObject({ verdict: "data_changed", columnsAdded: ["REGION"], columnsRemoved: [] });
    expect(added.compared[0].columns.map((c) => c.name)).toEqual(["ID", "AMOUNT"]);
    const removed = compare([step("V_OUT")], [step("V_OUT", { columns: [id()] })]);
    expect(removed.compared[0]).toMatchObject({ verdict: "data_changed", columnsAdded: [], columnsRemoved: ["AMOUNT"] });
  });

  it("sees a column with another data type as changed", () => {
    const c = compare([step("V_OUT")], [step("V_OUT", { columns: [id(), amount("1234.50", { dataType: "DOUBLE", sumScale: 6 })] })]);
    expect(c.compared[0].columns[1]).toMatchObject({ dataType: { before: "DECIMAL", after: "DOUBLE" }, changed: true, sum: { changed: false } });
    expect(c.verdict).toBe("data_changed");
  });

  it("tells a changed definition apart from changed data, and both", () => {
    const logic = compare([step("V_OUT")], [step("V_OUT", { definitionHash: "def-new" })]);
    expect(logic.verdict).toBe("definition_changed");
    expect(logic.compared[0]).toMatchObject({ verdict: "definition_changed", definitionChanged: true });
    const both = compare([step("V_OUT")], [step("V_OUT", { definitionHash: "def-new", rows: 900 })]);
    expect(both.verdict).toBe("both");
    expect(both.compared[0].verdict).toBe("both");
  });

  it("lists a step measured in one snapshot only apart, with the reason, and doesn't call its data changed", () => {
    const c = compare([step("V_OUT"), step("V_MID")], [step("V_OUT"), step("V_MID", { status: "not_measurable", reason: "not-visible", rows: null, columns: null })]);
    expect(c.verdict).toBe("unchanged");
    expect(c.compared.map((o) => o.technicalName)).toEqual(["V_OUT"]);
    expect(c.measuredOnce).toEqual([
      { space: "SALES", technicalName: "V_MID", type: "sql_view", before: { status: "measured", reason: null }, after: { status: "not_measurable", reason: "not-visible" }, definitionChanged: false },
    ]);
    const failed = compare([step("V_OUT", { status: "failed", reason: "The database user's sign-in failed", rows: null, columns: null })], [step("V_OUT")]);
    expect(failed.measuredOnce[0].before).toEqual({ status: "failed", reason: "The database user's sign-in failed" });
  });

  it("still compares the definitions of steps measured in neither", () => {
    const flow = (o: Partial<SnapshotObject> = {}) => step("TF_LOAD", { type: "transformation_flow", status: "not_measurable", reason: "process", rows: null, columns: null, ...o });
    expect(compare([flow(), step("V_OUT")], [flow(), step("V_OUT")]).definitionsOnly).toEqual([
      { space: "SALES", technicalName: "TF_LOAD", type: "transformation_flow", before: { status: "not_measurable", reason: "process" }, after: { status: "not_measurable", reason: "process" }, definitionChanged: false },
    ]);
    const changed = compare([flow(), step("V_OUT")], [flow({ definitionHash: "def-new" }), step("V_OUT")]);
    expect(changed.definitionsOnly[0].definitionChanged).toBe(true);
    expect(changed.verdict).toBe("definition_changed");
  });

  it("counts a step added to or removed from the pipeline as a changed definition", () => {
    const c = compare([step("V_OUT"), step("V_OLD")], [step("V_NEW"), step("V_OUT")]);
    expect(c.added).toEqual([{ space: "SALES", technicalName: "V_NEW", type: "sql_view" }]);
    expect(c.removed).toEqual([{ space: "SALES", technicalName: "V_OLD", type: "sql_view" }]);
    expect(c.verdict).toBe("definition_changed");
  });

  it("puts changed steps first, then the others in step order", () => {
    const c = compare([step("V_A"), step("V_B"), step("V_C")], [step("V_A"), step("V_B", { rows: 1 }), step("V_C")]);
    expect(c.compared.map((o) => [o.technicalName, o.verdict])).toEqual([
      ["V_B", "data_changed"],
      ["V_A", "unchanged"],
      ["V_C", "unchanged"],
    ]);
  });

  it("compares the hashed sums of small objects, never their values", () => {
    const small = (sumHash: string) => step("V_OUT", { rows: 4, columns: [amount("", { nonNull: 4, sum: null, sumHash })] });
    expect(compare([small("8".repeat(64))], [small("8".repeat(64))]).compared[0].columns[0]).toMatchObject({ sumHash: "unchanged", changed: false });
    const c = compare([small("8".repeat(64))], [small("9".repeat(64))]).compared[0].columns[0];
    expect(c).toMatchObject({ sumHash: "changed", changed: true });
    expect(c.sum).toBeUndefined();
  });
});

describe("sums of decimals", () => {
  const sumOf = (before: ColumnMeasures, after: ColumnMeasures) => compare([step("V_OUT", { columns: [before] })], [step("V_OUT", { columns: [after] })]).compared[0].columns[0];

  it("are equal however they are written, at the scale they were taken at", () => {
    expect(sumOf(amount("1234.50"), amount("1234.5")).sum).toMatchObject({ before: "1234.50", after: "1234.50", difference: "0.00", changed: false });
    expect(sumOf(amount("-0.10"), amount("-.1")).sum?.changed).toBe(false);
  });

  it("still show a real change in the last decimal", () => {
    expect(sumOf(amount("1234.50"), amount("1234.51")).sum).toMatchObject({ difference: "0.01", changed: true });
  });

  it("don't raise false alarms on floating noise in snapshots from before the scale was stored", () => {
    // A DOUBLE sum written by JavaScript, its last digits depending on the order HANA added the rows in.
    const double = (sum: string): ColumnMeasures => ({ name: "RATE", dataType: "DOUBLE", nonNull: 50, distinct: 20, minHash: "a".repeat(64), maxHash: "b".repeat(64), sum, sumHash: null });
    expect(sumOf(double("1234.5000000000002"), double("1234.4999999999998")).sum).toMatchObject({ before: "1234.500000", after: "1234.500000", changed: false });
    expect(sumOf(double("1.2e+21"), double("1200000000000000000000")).sum?.changed).toBe(false);
    expect(sumOf(double("1234.5000000000002"), double("1234.5000020000002")).sum?.changed).toBe(true);
  });

  it("are compared at the larger scale when a column's scale changed", () => {
    expect(sumOf(amount("10.00", { sumScale: 2 }), amount("10.000", { sumScale: 3 })).sum).toMatchObject({ after: "10.000", changed: false });
  });

  it("say a sum appeared or disappeared, without a difference", () => {
    expect(sumOf(amount("12.00"), amount("", { sum: null })).sum).toMatchObject({ before: "12.00", after: null, difference: null, percent: null, changed: true });
  });
});

describe("exact decimals", () => {
  it("read HANA's and JavaScript's ways of writing a number", () => {
    expect(parseDecimal("-1234.5600")).toEqual({ value: -12345600n, scale: 4 });
    expect(parseDecimal("1.2e+21")).toEqual({ value: 1200000000000000000000n, scale: 0 });
    expect(parseDecimal("5e-3")).toEqual({ value: 5n, scale: 3 });
    expect(parseDecimal(".5")).toEqual({ value: 5n, scale: 1 });
    for (const text of ["", "-", ".", "abc", "1.2.3", "NaN"]) expect(parseDecimal(text), text).toBeUndefined();
  });

  it("round half away from zero and print at their scale", () => {
    expect(atScale({ value: 125n, scale: 3 }, 2)).toBe(13n);
    expect(atScale({ value: -125n, scale: 3 }, 2)).toBe(-13n);
    expect(atScale({ value: 124n, scale: 3 }, 2)).toBe(12n);
    expect(atScale({ value: 5n, scale: 0 }, 2)).toBe(500n);
    expect(formatDecimal(-13n, 2)).toBe("-0.13");
    expect(formatDecimal(123450n, 2)).toBe("1234.50");
    expect(formatDecimal(7n, 0)).toBe("7");
  });
});
