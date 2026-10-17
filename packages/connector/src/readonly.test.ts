import { describe, expect, it } from "vitest";
import { assertReadOnly, assertSelectOnly, NotSelectError, WriteAttemptError } from "./readonly.js";

describe("read-only guard", () => {
  it("allows listing and reading objects", () => {
    expect(() => assertReadOnly(["objects", "views", "list"])).not.toThrow();
    expect(() => assertReadOnly(["objects", "transformation-flows", "read"])).not.toThrow();
    expect(() => assertReadOnly(["spaces", "list"])).not.toThrow();
  });

  it("allows filling the CLI's local command cache, which changes nothing in the tenant", () => {
    expect(() => assertReadOnly(["config", "cache", "init"])).not.toThrow();
  });

  it.each([
    [["objects", "views", "create"]],
    [["objects", "local-tables", "delete"]],
    [["objects", "views", "update"]],
    [["tasks", "chains", "run"]],
    [["spaces", "create"]],
    [["objects", "not-a-kind", "read"]],
    [["objects", "views", "read", "extra"]],
    [["config", "secrets", "show"]],
    [["config", "cache", "clean"]],
    [["config", "cache"]],
    [["login"]],
    [["logout"]],
    [[]],
  ])("blocks %j", (path) => {
    expect(() => assertReadOnly(path)).toThrow(WriteAttemptError);
  });
});

describe("SQL read-only guard", () => {
  it.each([
    'select count(*) as "rows" from "SALES"."ORDERS_SYNTH_V"',
    "  SELECT top 1 1 from DUMMY",
    'select object_name from sys.objects where schema_name = ? and object_type in (\'TABLE\', \'VIEW\')',
    'select count(*) from "SALES"."A;B -- C /* D"',
    "select 'it''s; -- fine' from dummy",
    'select "INTO", "FOR UPDATE" from "S"."T"',
  ])("allows %s", (sql) => {
    expect(() => assertSelectOnly(sql)).not.toThrow();
  });

  it.each([
    ["insert into \"S\".\"T\" values (1)", "it doesn't start with SELECT"],
    ["delete from T", "it doesn't start with SELECT"],
    ["upsert T values (1) with primary key", "it doesn't start with SELECT"],
    ["call SYS.SOMETHING()", "it doesn't start with SELECT"],
    ["with x as (select 1 from dummy) select * from x", "it doesn't start with SELECT"],
    ["", "it doesn't start with SELECT"],
    ["select 1 from dummy; delete from T", "a semicolon"],
    ["select 1 from dummy -- comment", "a comment"],
    ["select /* comment */ 1 from dummy", "a comment"],
    ["select a into b from c", "INTO"],
    ["select * from T for update", "a row lock"],
    ["select * from T for  share lock", "a row lock"],
    ['select "unclosed from T; drop table T', "an unclosed quote"],
    ["select 'unclosed from T", "an unclosed quote"],
  ])("blocks %s", (sql, reason) => {
    expect(() => assertSelectOnly(sql)).toThrow(NotSelectError);
    expect(() => assertSelectOnly(sql)).toThrow(reason);
  });
});
