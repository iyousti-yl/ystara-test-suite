import type { ColumnMeasures, Snapshot, SnapshotDetails, SnapshotObject } from "./api.js";
import { refKey, type DspObjectRef } from "./objects.js";

/**
 * Comparing two snapshots of one saved pipeline (phase 2d): what changed in
 * each step between them, from what the snapshots stored and nothing else.
 *
 * A step's definition changed when its definition hash differs; its data
 * changed when its row count, any column measure or its set of columns
 * differs. Counts and hashes compare exactly. Sums compare exactly as numbers
 * at the scale they were taken at (`sumScale`), so "12.50" equals "12.5" and a
 * real change in the last decimal still shows. Plain functions, so the API and
 * the web app can share them.
 */

export type Verdict = "unchanged" | "data_changed" | "definition_changed" | "both";

export const verdictOf = (definitionChanged: boolean, dataChanged: boolean): Verdict =>
  definitionChanged ? (dataChanged ? "both" : "definition_changed") : dataChanged ? "data_changed" : "unchanged";

/** A count before and after. `percent` is null when it was 0 before. */
export interface CountChange {
  before: number;
  after: number;
  difference: number;
  percent: number | null;
}

/** A sum before and after, as exact decimal text at the scale it is compared at. Null where there was no sum. */
export interface SumChange {
  before: string | null;
  after: string | null;
  difference: string | null;
  percent: number | null;
  changed: boolean;
}

/** Min, max and the sums of small objects are stored only as hashes: all a comparison can say is whether they changed. */
export type HashChange = "changed" | "unchanged";

/** A column in both snapshots of a step. A measure is left out when either snapshot has no such measure for it. */
export interface ColumnComparison {
  name: string;
  dataType: { before: string; after: string };
  nonNull: CountChange;
  distinct?: CountChange;
  min?: HashChange;
  max?: HashChange;
  sum?: SumChange;
  /** The hashed sum of an object under 10 rows. */
  sumHash?: HashChange;
  changed: boolean;
}

/** A step measured in both snapshots. */
export interface ObjectComparison extends DspObjectRef {
  verdict: Verdict;
  definitionChanged: boolean;
  rows: CountChange;
  /** The columns in both, in the later snapshot's order. */
  columns: ColumnComparison[];
  columnsAdded: string[];
  columnsRemoved: string[];
}

/** How a step ended in one snapshot: `reason` is why it couldn't be measured, or the error that stopped it. */
export interface StepState {
  status: SnapshotObject["status"];
  reason: string | null;
}

/** A step in both snapshots whose data couldn't be compared: only its definition is. */
export interface StepNotCompared extends DspObjectRef {
  before: StepState;
  after: StepState;
  definitionChanged: boolean;
}

/** GET /api/pipelines/:id/compare */
export interface SnapshotComparison {
  before: Snapshot;
  after: Snapshot;
  /** For the whole pipeline: a definition changed, or a step was added or removed; data changed in a step measured in both. */
  verdict: Verdict;
  /** Steps measured in both: changed ones first, then in the later snapshot's step order. */
  compared: ObjectComparison[];
  /** Steps measured in only one of the two, with the reason from the other. */
  measuredOnce: StepNotCompared[];
  /** Steps measured in neither (flows, steps the database users don't see): their definitions only. */
  definitionsOnly: StepNotCompared[];
  /** Steps in only one snapshot: the pipeline itself changed between them. */
  added: DspObjectRef[];
  removed: DspObjectRef[];
}

export function compareSnapshots(before: SnapshotDetails, after: SnapshotDetails): SnapshotComparison {
  const earlier = new Map(before.objects.map((o) => [refKey(o), o]));
  const later = new Set(after.objects.map(refKey));
  const result: SnapshotComparison = {
    before: summary(before),
    after: summary(after),
    verdict: "unchanged",
    compared: [],
    measuredOnce: [],
    definitionsOnly: [],
    added: [],
    removed: before.objects.filter((o) => !later.has(refKey(o))).map(ref),
  };

  for (const now of after.objects) {
    const then = earlier.get(refKey(now));
    if (!then) result.added.push(ref(now));
    else if (then.status === "measured" && now.status === "measured") result.compared.push(compareObject(then, now));
    else {
      const step = { ...ref(now), before: state(then), after: state(now), definitionChanged: then.definitionHash !== now.definitionHash };
      (then.status === "measured" || now.status === "measured" ? result.measuredOnce : result.definitionsOnly).push(step);
    }
  }
  // Changed first; sort is stable, so each group keeps the step order.
  result.compared.sort((a, b) => Number(a.verdict === "unchanged") - Number(b.verdict === "unchanged"));

  const definitionChanged =
    result.added.length > 0 ||
    result.removed.length > 0 ||
    [...result.compared, ...result.measuredOnce, ...result.definitionsOnly].some((s) => s.definitionChanged);
  const dataChanged = result.compared.some((o) => o.verdict === "data_changed" || o.verdict === "both");
  result.verdict = verdictOf(definitionChanged, dataChanged);
  return result;
}

function compareObject(then: SnapshotObject, now: SnapshotObject): ObjectComparison {
  const earlier = new Map((then.columns ?? []).map((c) => [c.name, c]));
  const laterNames = new Set((now.columns ?? []).map((c) => c.name));
  const columns = (now.columns ?? []).filter((c) => earlier.has(c.name)).map((c) => compareColumn(earlier.get(c.name)!, c));
  const columnsAdded = (now.columns ?? []).filter((c) => !earlier.has(c.name)).map((c) => c.name);
  const columnsRemoved = (then.columns ?? []).filter((c) => !laterNames.has(c.name)).map((c) => c.name);
  const rows = count(then.rows ?? 0, now.rows ?? 0);
  const definitionChanged = then.definitionHash !== now.definitionHash;
  const dataChanged = rows.difference !== 0 || columns.some((c) => c.changed) || columnsAdded.length > 0 || columnsRemoved.length > 0;
  return { ...ref(now), verdict: verdictOf(definitionChanged, dataChanged), definitionChanged, rows, columns, columnsAdded, columnsRemoved };
}

function compareColumn(then: ColumnMeasures, now: ColumnMeasures): ColumnComparison {
  const c: ColumnComparison = { name: now.name, dataType: { before: then.dataType, after: now.dataType }, nonNull: count(then.nonNull, now.nonNull), changed: false };
  if (then.distinct !== undefined && now.distinct !== undefined) c.distinct = count(then.distinct, now.distinct);
  if (then.minHash !== undefined && now.minHash !== undefined) c.min = hash(then.minHash, now.minHash);
  if (then.maxHash !== undefined && now.maxHash !== undefined) c.max = hash(then.maxHash, now.maxHash);
  if (then.sum !== undefined && now.sum !== undefined && (then.sum !== null || now.sum !== null)) c.sum = sum(then, now);
  if (then.sumHash !== undefined && now.sumHash !== undefined && (then.sumHash !== null || now.sumHash !== null)) c.sumHash = hash(then.sumHash, now.sumHash);
  c.changed =
    then.dataType !== now.dataType ||
    c.nonNull.difference !== 0 ||
    (c.distinct?.difference ?? 0) !== 0 ||
    [c.min, c.max, c.sumHash].includes("changed") ||
    c.sum?.changed === true;
  return c;
}

const count = (before: number, after: number): CountChange => ({ before, after, difference: after - before, percent: before === 0 ? null : ((after - before) / before) * 100 });

const hash = (before: string | null, after: string | null): HashChange => (before === after ? "unchanged" : "changed");

const INTEGER_TYPES = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT"]);

/** The scale a sum is compared at: the one it was taken at, or for snapshots that didn't store it 0 for integers and 6 otherwise. */
const scaleOf = (c: ColumnMeasures) => c.sumScale ?? (INTEGER_TYPES.has(c.dataType.toUpperCase()) ? 0 : 6);

function sum(then: ColumnMeasures, now: ColumnMeasures): SumChange {
  const scale = Math.max(scaleOf(then), scaleOf(now));
  const before = then.sum == null ? undefined : parseDecimal(then.sum);
  const after = now.sum == null ? undefined : parseDecimal(now.sum);
  const b = before && atScale(before, scale);
  const a = after && atScale(after, scale);
  const difference = a !== undefined && b !== undefined ? a - b : undefined;
  return {
    before: b === undefined ? (then.sum ?? null) : formatDecimal(b, scale),
    after: a === undefined ? (now.sum ?? null) : formatDecimal(a, scale),
    difference: difference === undefined ? null : formatDecimal(difference, scale),
    percent: difference === undefined || b === 0n || b === undefined ? null : (Number(difference) / Number(b)) * 100,
    changed: a === undefined || b === undefined ? then.sum !== now.sum : a !== b,
  };
}

/** A decimal as written by HANA or by JavaScript ("-1234.5600", "1.2e+21") as an exact integer and its scale. */
export function parseDecimal(text: string): { value: bigint; scale: number } | undefined {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return undefined;
  const fraction = m[3] ?? "";
  let value = BigInt(`${m[1] === "-" ? "-" : ""}${m[2] || "0"}${fraction}`);
  let scale = fraction.length - Number(m[4] ?? 0);
  if (scale < 0) {
    value *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { value, scale };
}

/** The decimal rounded (half away from zero) or extended to `scale` decimals, as an integer of that many decimals. */
export function atScale(d: { value: bigint; scale: number }, scale: number): bigint {
  if (d.scale <= scale) return d.value * 10n ** BigInt(scale - d.scale);
  const divisor = 10n ** BigInt(d.scale - scale);
  const quotient = d.value / divisor;
  const rest = d.value % divisor;
  const sign = d.value < 0n ? -1n : 1n;
  return rest * sign * 2n >= divisor ? quotient + sign : quotient;
}

/** An integer of `scale` decimals as text: 123450n at 2 -> "1234.50". */
export function formatDecimal(value: bigint, scale: number): string {
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return value < 0n ? `-${whole}` : whole;
}

const ref = (o: DspObjectRef): DspObjectRef => ({ space: o.space, technicalName: o.technicalName, type: o.type });
const state = (o: SnapshotObject): StepState => ({ status: o.status, reason: o.reason });

const summary = ({ objects: _objects, ...snapshot }: SnapshotDetails): Snapshot => snapshot;
