import { z } from "zod";
import YAML from "yaml";

/**
 * Scenario specification (YAML).
 *
 * This is the single source of truth for a test scenario. The visual builder
 * produces exactly this shape, and the code editor edits it directly, so both
 * kinds of users create the same artefact and it can live in Git.
 *
 * A scenario runs as a read-only simulation (overview, "How a scenario run
 * works"): nothing is loaded into or run in the tenant. Its fixtures stand in
 * for the pipeline's tables, every view and SQL transformation flow is
 * compiled from its definition over them, and the assertions are checked on
 * the result at each checkpoint. A table the scenario gives no rows for is
 * empty.
 *
 * Example:
 *
 *   name: "New hire with no manager"
 *   kind: outlying
 *   pipeline: HR.V_HEADCOUNT_OUT
 *   fixtures:
 *     - table: LT_EMPLOYEE_RAW
 *       rows:
 *         - { EMP_ID: "E1", MANAGER_ID: null, HIRE_DATE: "2026-01-15", STATUS: "A" }
 *   expect:
 *     - checkpoint: V_HEADCOUNT_OUT
 *       assertions:
 *         - { type: row_count, equals: 1 }
 *         - { type: no_nulls, columns: [ORG_ID] }
 *         - { type: sql, query: "SELECT COUNT(*) FROM {{checkpoint}} WHERE HEADCOUNT > 1", equals: 0 }
 */

export const ScenarioKind = z.enum(["golden", "common", "outlying"]);

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Columns = z.array(z.string().min(1)).min(1);

export const Fixture = z
  .object({
    /** A table of the pipeline: NAME, or SPACE.NAME. */
    table: z.string().min(1),
    /** Either inline rows or a reference to an uploaded CSV. No rows: the table is empty. */
    rows: z.array(z.record(Cell)).optional(),
    csv: z.string().optional(),
  })
  .strict();

export const Assertion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("row_count"), equals: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("no_nulls"), columns: Columns }).strict(),
  z.object({ type: z.literal("unique"), columns: Columns }).strict(),
  z
    .object({
      type: z.literal("aggregate"),
      column: z.string().min(1),
      fn: z.enum(["sum", "min", "max", "avg", "count_distinct"]),
      equals: z.number(),
      tolerance: z.number().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("rows_equal"),
      /** Expected result set; matched on `key` columns, then the other columns the rows name are compared by value. */
      key: Columns,
      rows: z.array(z.record(Cell)),
    })
    .strict(),
  z
    .object({
      type: z.literal("sql"),
      /** One SELECT that returns one row with one column. `{{checkpoint}}` stands for the checkpoint's result, as a subquery. */
      query: z.string().min(1),
      equals: Cell,
    })
    .strict(),
]);

export const Expectation = z
  .object({
    /** A step of the pipeline: NAME, or SPACE.NAME. */
    checkpoint: z.string().min(1),
    assertions: z.array(Assertion).min(1),
  })
  .strict();

export const ScenarioSpec = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1),
    description: z.string().optional(),
    kind: ScenarioKind,
    /** The pipeline's output: NAME, or SPACE.NAME. */
    pipeline: z.string().min(1),
    tags: z.array(z.string()).default([]),
    fixtures: z.array(Fixture).min(1),
    expect: z.array(Expectation).min(1),
  })
  .strict();

export type ScenarioSpec = z.infer<typeof ScenarioSpec>;
export type Fixture = z.infer<typeof Fixture>;
export type Assertion = z.infer<typeof Assertion>;
export type Expectation = z.infer<typeof Expectation>;

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

/** A failed parse in plain lines: where in the file, and what is wrong. */
export function scenarioProblems(error: unknown): string[] {
  if (error instanceof z.ZodError) return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "the file"}: ${i.message}`);
  return [error instanceof Error ? error.message : String(error)];
}
