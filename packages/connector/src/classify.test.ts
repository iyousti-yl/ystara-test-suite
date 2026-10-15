import { describe, expect, it } from "vitest";
import { classifyKind, classifyObject, hashDefinition } from "./classify.js";

describe("classifyKind", () => {
  it("maps known CLI kinds to object types", () => {
    expect(classifyKind("transformation-flows")).toBe("transformation_flow");
    expect(classifyKind("task-chains")).toBe("task_chain");
  });

  it("keeps unknown kinds as 'unknown' instead of dropping them", () => {
    expect(classifyKind("something-new")).toBe("unknown");
  });
});

describe("classifyObject", () => {
  it("splits the merged views command into SQL and graphical views", () => {
    expect(classifyObject("views", { definitions: { V: { "@DataWarehouse.sqlEditor.query": "SELECT 1 FROM DUMMY" } } })).toBe("sql_view");
    expect(classifyObject("views", { definitions: { V: { "@DataWarehouse.querybuilder.model": {} } } })).toBe("graphical_view");
  });
});

describe("hashDefinition", () => {
  it("ignores key order and changes when the content changes", () => {
    const a = { kind: "entity", elements: { ID: { type: "cds.String" } } };
    const b = { elements: { ID: { type: "cds.String" } }, kind: "entity" };
    expect(hashDefinition(a)).toBe(hashDefinition(b));
    expect(hashDefinition(a)).not.toBe(hashDefinition({ ...a, kind: "view" }));
  });
});
