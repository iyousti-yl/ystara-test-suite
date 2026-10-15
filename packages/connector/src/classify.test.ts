import { describe, expect, it } from "vitest";
import { classifyKind, hashDefinition, DEPLOYABLE } from "./classify.js";

describe("classifyKind", () => {
  it("maps known CLI kinds to object types", () => {
    expect(classifyKind("transformation-flows")).toBe("transformation_flow");
    expect(classifyKind("task-chains")).toBe("task_chain");
  });

  it("keeps unknown kinds as 'unknown' instead of dropping them", () => {
    expect(classifyKind("something-new")).toBe("unknown");
  });
});

describe("hashDefinition", () => {
  it("is stable for equal definitions and changes when the definition changes", () => {
    const a = { kind: "entity", elements: { ID: { type: "cds.String" } } };
    expect(hashDefinition(a)).toBe(hashDefinition(structuredClone(a)));
    expect(hashDefinition(a)).not.toBe(hashDefinition({ ...a, kind: "view" }));
  });
});

describe("DEPLOYABLE", () => {
  it("never treats remote tables as deployable (they point at live sources)", () => {
    expect(DEPLOYABLE.has("remote_table")).toBe(false);
  });
});
