import { describe, expect, it } from "vitest";
import { parseFixturesYaml, parseScenarioYaml, toScenarioYaml } from "./scenario.js";

const sample = `
name: New hire with no manager
kind: outlying
pipeline: hr_headcount_to_cpi
fixtures:
  - table: SF_EMPLOYEE_RAW
    rows:
      - { EMP_ID: "E1", MANAGER_ID: null, HIRE_DATE: "2026-01-15", STATUS: "A" }
run:
  - task_chain: TC_HR_DAILY
expect:
  - checkpoint: V_HEADCOUNT_OUT
    assertions:
      - { type: row_count, equals: 1 }
      - { type: no_nulls, columns: [EMP_ID] }
      - { type: sql, query: "SELECT COUNT(*) FROM {{checkpoint}} WHERE MANAGER_ID IS NULL", equals: 1 }
`;

describe("scenario spec", () => {
  it("parses a valid scenario and applies defaults", () => {
    const spec = parseScenarioYaml(sample);
    expect(spec.version).toBe(1);
    expect(spec.fixtures[0].truncate).toBe(true);
    expect(spec.expect[0].assertions).toHaveLength(3);
  });

  it("round-trips through YAML", () => {
    const spec = parseScenarioYaml(sample);
    expect(parseScenarioYaml(toScenarioYaml(spec))).toEqual(spec);
  });

  it("rejects an unknown assertion type", () => {
    const bad = sample.replace("type: row_count", "type: magic");
    expect(() => parseScenarioYaml(bad)).toThrow();
  });
});

describe("fixtures YAML", () => {
  it("reads a scenario's fixtures, or a plain list of tables and rows", () => {
    expect(parseFixturesYaml(sample)).toEqual([
      { table: "SF_EMPLOYEE_RAW", rows: [{ EMP_ID: "E1", MANAGER_ID: null, HIRE_DATE: "2026-01-15", STATUS: "A" }], truncate: true },
    ]);
    expect(parseFixturesYaml("- table: LT_A\n  rows: [{ ID: 1 }]\n- table: LT_B\n  rows: []\n").map((f) => [f.table, f.rows])).toEqual([
      ["LT_A", [{ ID: 1 }]],
      ["LT_B", []],
    ]);
    expect(() => parseFixturesYaml("name: no fixtures here")).toThrow();
  });
});
