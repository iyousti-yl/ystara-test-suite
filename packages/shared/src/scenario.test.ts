import { describe, expect, it } from "vitest";
import { parseFixturesYaml, parseScenarioYaml, scenarioProblems, toScenarioYaml } from "./scenario.js";

const sample = `
name: New hire with no manager
kind: outlying
pipeline: HR.V_HEADCOUNT_OUT
fixtures:
  - table: LT_EMPLOYEE_RAW
    rows:
      - { EMP_ID: "E1", MANAGER_ID: null, HIRE_DATE: "2026-01-15", STATUS: "A" }
expect:
  - checkpoint: V_HEADCOUNT_OUT
    assertions:
      - { type: row_count, equals: 1 }
      - { type: no_nulls, columns: [ORG_ID] }
      - { type: sql, query: "SELECT COUNT(*) FROM {{checkpoint}} WHERE HEADCOUNT > 1", equals: 0 }
`;

describe("scenario spec", () => {
  it("parses a valid scenario and applies defaults", () => {
    const spec = parseScenarioYaml(sample);
    expect(spec.version).toBe(1);
    expect(spec.tags).toEqual([]);
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

  it("rejects keys it doesn't know, so a misspelt one isn't ignored, and says where", () => {
    // Nothing runs or loads in the tenant, so the old `run` and `truncate` keys are refused too.
    const withRun = `${sample}run:\n  - task_chain: TC_HR_DAILY\n`;
    let problems: string[] = [];
    try {
      parseScenarioYaml(withRun);
    } catch (e) {
      problems = scenarioProblems(e);
    }
    expect(problems).toEqual(["the file: Unrecognized key(s) in object: 'run'"]);
    const misspelt = sample.replace("{ type: row_count, equals: 1 }", "{ type: row_count, equal: 1 }");
    expect(() => parseScenarioYaml(misspelt)).toThrow();
  });
});

describe("fixtures YAML", () => {
  it("reads a scenario's fixtures, or a plain list of tables and rows", () => {
    expect(parseFixturesYaml(sample)).toEqual([{ table: "LT_EMPLOYEE_RAW", rows: [{ EMP_ID: "E1", MANAGER_ID: null, HIRE_DATE: "2026-01-15", STATUS: "A" }] }]);
    expect(parseFixturesYaml("- table: LT_A\n  rows: [{ ID: 1 }]\n- table: LT_B\n  rows: []\n").map((f) => [f.table, f.rows])).toEqual([
      ["LT_A", [{ ID: 1 }]],
      ["LT_B", []],
    ]);
    expect(() => parseFixturesYaml("name: no fixtures here")).toThrow();
  });
});
