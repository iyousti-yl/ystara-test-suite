import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertSelectOnly, NotSelectError } from "./readonly.js";
import { checkDatabaseUser, columnMetrics, metricsQuery, quoteIdentifier, SqlReader } from "./sql.js";

// A stand-in for hdb that records what reaches the database. `rowsFor` answers each statement; `failWith` fails every call.
const sent: { sql: string; params?: unknown[] }[] = [];
let failWith: string | undefined;
let rowsFor: (sql: string) => unknown = () => [{ one: 1 }];
vi.mock("hdb", () => {
  const answer = (cb: (err: Error | null, result: unknown) => void, rows: unknown) =>
    setImmediate(() => (failWith ? cb(new Error(failWith), undefined) : rows instanceof Error ? cb(rows, undefined) : cb(null, rows)));
  return {
    default: {
      createClient: (options: { password: string }) => ({
        options,
        on: () => undefined,
        connect: (cb: (err: Error | null) => void) => answer(cb, undefined),
        exec: (sql: string, cb: (err: Error | null, rows: unknown) => void) => {
          sent.push({ sql });
          answer(cb, rowsFor(sql));
        },
        prepare: (sql: string, cb: (err: Error | null, statement: unknown) => void) =>
          cb(null, {
            exec: (params: unknown[], done: (err: Error | null, rows: unknown) => void) => {
              sent.push({ sql, params });
              answer(done, rowsFor(sql));
            },
            drop: (done: () => void) => {
              sent.push({ sql: "(dropped)" });
              done();
            },
          }),
        disconnect: (cb: (err: Error | null) => void) => cb(null),
        close: () => undefined,
      }),
    },
  };
});

const user = { host: "synthetic.hana.prod-eu10.hanacloud.ondemand.com", user: "SALES#SYNTH", password: "pa55-synthetic" };
beforeEach(() => {
  sent.length = 0;
  failWith = undefined;
  rowsFor = () => [{ one: 1 }];
});

describe("SqlReader", () => {
  it("sends a SELECT, with values as parameters", async () => {
    const sql = await SqlReader.connect(user);
    expect(await sql.select("select top 1 1 as \"one\" from dummy")).toEqual([{ one: 1 }]);
    await sql.select("select object_name from sys.objects where schema_name = ?", ["SALES"]);
    expect(sent).toEqual([
      { sql: 'select top 1 1 as "one" from dummy' },
      { sql: "select object_name from sys.objects where schema_name = ?", params: ["SALES"] },
      { sql: "(dropped)" },
    ]);
  });

  it("never sends anything but a SELECT", async () => {
    const sql = await SqlReader.connect(user);
    await expect(sql.select('delete from "SALES"."ORDERS_SYNTH"')).rejects.toThrow(NotSelectError);
    await expect(sql.select("select 1 from dummy; drop table T")).rejects.toThrow(NotSelectError);
    expect(sent).toEqual([]);
  });

  it("sends the password only to SAP HANA Cloud", async () => {
    for (const host of ["synthetic.example.com", "synthetic.hana.prod-eu10.hanacloud.ondemand.com.example.com", "10.0.0.1"]) {
      await expect(SqlReader.connect({ ...user, host }), host).rejects.toThrow("is not a Datasphere database host");
    }
    expect(sent).toEqual([]);
  });

  it("cuts the password out of an error", async () => {
    const sql = await SqlReader.connect(user);
    failWith = `authentication failed for SALES#SYNTH with ${user.password}`;
    await expect(sql.select("select 1 from dummy")).rejects.toThrow("authentication failed for SALES#SYNTH with <password>");
  });
});

describe("quoteIdentifier", () => {
  it("quotes names and doubles their quotes", () => {
    expect(quoteIdentifier("SALES")).toBe('"SALES"');
    expect(quoteIdentifier('A"B')).toBe('"A""B"');
  });
});

describe("columnMetrics", () => {
  it("measures numbers fully, dates and texts without a sum, and large objects only for nulls", () => {
    expect(columnMetrics("DECIMAL")).toEqual(["nonNull", "distinct", "min", "max", "sum"]);
    expect(columnMetrics("date")).toEqual(["nonNull", "distinct", "min", "max"]);
    expect(columnMetrics("NVARCHAR")).toEqual(["nonNull", "distinct", "min", "max"]);
    expect(columnMetrics("BOOLEAN")).toEqual(["nonNull", "distinct"]);
    expect(columnMetrics("NCLOB")).toEqual(["nonNull"]);
  });
});

describe("metricsQuery", () => {
  it("measures a view in one SELECT that passes the read-only guard", () => {
    const { sql, columns } = metricsQuery("SALES", "ORDERS_SYNTH_V", [
      { name: "ORDER_ID", dataType: "NVARCHAR" },
      { name: "AMOUNT", dataType: "DECIMAL" },
      { name: 'ODD"NAME;--', dataType: "NCLOB" },
    ]);
    expect(sql).toBe(
      'select count(*) as "rows", count("ORDER_ID") as "c0_nonNull", count(distinct "ORDER_ID") as "c0_distinct", min("ORDER_ID") as "c0_min", max("ORDER_ID") as "c0_max", ' +
        'count("AMOUNT") as "c1_nonNull", count(distinct "AMOUNT") as "c1_distinct", min("AMOUNT") as "c1_min", max("AMOUNT") as "c1_max", sum("AMOUNT") as "c1_sum", ' +
        'count("ODD""NAME;--") as "c2_nonNull" from "SALES"."ORDERS_SYNTH_V"',
    );
    expect(() => assertSelectOnly(sql)).not.toThrow();
    expect(columns.map((c) => c.metrics.length)).toEqual([4, 5, 1]);
  });
});

describe("checkDatabaseUser", () => {
  const privileges = (...rows: { privilege: string; schema: string | null }[]) => (sql: string) =>
    sql.includes("current_user")
      ? [{ user: "SALES#SYNTH" }]
      : sql.includes("effective_privileges")
        ? rows
        : [
            { name: "ORDERS_SYNTH_V", type: "VIEW" },
            { name: "REVENUE_SYNTH_V", type: "VIEW" },
          ];

  it("lists what a user that can only read sees in its space, with SELECTs only", async () => {
    rowsFor = privileges({ privilege: "SELECT", schema: "SALES" }, { privilege: "CREATE ANY", schema: "SALES#SYNTH" }, { privilege: "SELECT", schema: "SYS" });
    expect(await checkDatabaseUser(user, "SALES")).toEqual({
      visible: [
        { name: "ORDERS_SYNTH_V", type: "VIEW" },
        { name: "REVENUE_SYNTH_V", type: "VIEW" },
      ],
    });
    expect(sent.filter((s) => s.sql !== "(dropped)").map((s) => s.params)).toEqual([undefined, ["SALES#SYNTH"], ["SALES"]]);
    for (const s of sent.filter((s) => s.sql !== "(dropped)")) expect(() => assertSelectOnly(s.sql)).not.toThrow();
  });

  it("refuses a user that could change the space's schema", async () => {
    rowsFor = privileges({ privilege: "SELECT", schema: "SALES" }, { privilege: "INSERT", schema: "SALES" }, { privilege: "DELETE", schema: "SALES" });
    await expect(checkDatabaseUser(user, "SALES")).rejects.toThrow("This user can change the space's schema (INSERT, DELETE)");
    expect(sent.some((s) => s.sql.includes("sys.objects"))).toBe(false);
  });

  it("says which step failed, without the password", async () => {
    failWith = `authentication failed for SALES#SYNTH with ${user.password}`;
    await expect(checkDatabaseUser(user, "SALES")).rejects.toThrow("Signing in failed. Check the user name and password (repeated failed sign-ins can lock the user): authentication failed for SALES#SYNTH with <password>");

    failWith = undefined;
    rowsFor = (sql) => (sql.includes("effective_privileges") ? new Error("insufficient privilege") : [{ user: "SALES#SYNTH" }]);
    await expect(checkDatabaseUser(user, "SALES")).rejects.toThrow("can't read its own privileges");
  });

  it("doesn't sign in with a name something cut short", async () => {
    await expect(checkDatabaseUser({ ...user, user: "SALES" }, "SALES")).rejects.toThrow("Nothing was sent to the tenant");
    expect(sent).toEqual([]);
  });
});
