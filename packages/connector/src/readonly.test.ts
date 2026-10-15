import { describe, expect, it } from "vitest";
import { assertReadOnly, WriteAttemptError } from "./readonly.js";

describe("read-only guard", () => {
  it("allows listing and reading objects", () => {
    expect(() => assertReadOnly(["objects", "views", "list"])).not.toThrow();
    expect(() => assertReadOnly(["objects", "transformation-flows", "read"])).not.toThrow();
    expect(() => assertReadOnly(["spaces", "list"])).not.toThrow();
  });

  it.each([
    [["objects", "views", "create"]],
    [["objects", "local-tables", "delete"]],
    [["objects", "views", "update"]],
    [["tasks", "chains", "run"]],
    [["spaces", "create"]],
    [["objects", "not-a-kind", "read"]],
    [["objects", "views", "read", "extra"]],
    [[]],
  ])("blocks %j", (path) => {
    expect(() => assertReadOnly(path)).toThrow(WriteAttemptError);
  });
});
