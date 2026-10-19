import { z } from "zod";
import YAML from "yaml";

/**
 * Scenario specification (YAML).
 *
 * This is the single source of truth for a test scenario. The visual builder
 * produces exactly this shape, and the code editor edits it directly, so both
 * kinds of users create the same artefact and it can live in Git.
 *
 * Example:
 *
 *   name: "New hire with no manager"
 *   kind: outlying
 *   pipeline: hr_headcount_to_cpi
 *   fixtures:
 *     - table: SF_EMPLOYEE_RAW
 *       rows:
 *         - { EMP_ID: "E1", MANAGER_ID: null, HIRE_DATE: "2026-01-15", STATUS: "A" }
 *   run:
 *     - task_chain: TC_HR_DAILY
 *   expect:
 *     - checkpoint: V_HEADCOUNT_OUT
 *       assertions:
 *         - { type: row_count, equals: 1 }
 *         - { type: no_nulls, columns: [EMP_ID] }
 *         - { type: sql, query: "SELECT COUNT(*) FROM {{checkpoint}} WHERE MANAGER_ID IS NULL", equals: 1 }
 */

export const ScenarioKind = z.enum(["golden", "common", "outlying"]);

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const Fixture = z.object({
  table: z.string().min(1),
  /** Either inline rows or a reference to an uploaded CSV. */
  rows: z.array(z.record(Cell)).optional(),
  csv: z.string().optional(),
  /** Truncate the fixture table before loading. Default true. */
  truncate: z.boolean().default(true),
});

export const RunStep = z.union([
  z.object({ task_chain: z.string().min(1) }),
  z.object({ data_flow: z.string().min(1) }),
  z.object({ transformation_flow: z.string().min(1) }),
  z.object({ replication_flow: z.string().min(1) }),
]);

export const Assertion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("row_count"), equals: z.number().int().nonnegative() }),
  z.object({ type: z.literal("no_nulls"), columns: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("unique"), columns: z.array(z.string()).min(1) }),
  z.object({
    type: z.literal("aggregate"),
    column: z.string(),
    fn: z.enum(["sum", "min", "max", "avg", "count_distinct"]),
    equals: z.number(),
    tolerance: z.number().nonnegative().default(0),
  }),
  z.object({
    type: z.literal("rows_equal"),
    /** Expected result set; compared on `key` columns, remaining columns compared by value. */
    key: z.array(z.string()).min(1),
    rows: z.array(z.record(Cell)),
  }),
  z.object({
    type: z.literal("sql"),
    /** Must return one row, one column. `{{checkpoint}}` is replaced by the checkpoint object. */
    query: z.string().min(1),
    equals: Cell,
  }),
]);

export const Expectation = z.object({
  checkpoint: z.string().min(1),
  assertions: z.array(Assertion).min(1),
});

export const ScenarioSpec = z.object({
  version: z.literal(1).default(1),
  name: z.string().min(1),
  description: z.string().optional(),
  kind: ScenarioKind,
  pipeline: z.string().min(1),
  tags: z.array(z.string()).default([]),
  fixtures: z.array(Fixture).min(1),
  run: z.array(RunStep).default([]),
  expect: z.array(Expectation).min(1),
});

export type ScenarioSpec = z.infer<typeof ScenarioSpec>;
export type Fixture = z.infer<typeof Fixture>;
export type Assertion = z.infer<typeof Assertion>;

export function parseScenarioYaml(text: string): ScenarioSpec {
  return ScenarioSpec.parse(YAML.parse(text));
}

export function toScenarioYaml(spec: ScenarioSpec): string {
  return YAML.stringify(spec);
}

/** Fixtures from YAML: a scenario's `fixtures`, or a list of { table, rows }. */
export function parseFixturesYaml(text: string): Fixture[] {
  const parsed: unknown = YAML.parse(text);
  const list = Array.isArray(parsed) ? parsed : (parsed as { fixtures?: unknown } | null)?.fixtures;
  return z.array(Fixture).parse(list);
}
