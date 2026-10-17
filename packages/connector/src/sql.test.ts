import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertSelectOnly, NotSelectError } from "./readonly.js";
import { columnMetrics, metricsQuery, quoteIdentifier, SqlReader } from "./sql.js";

// A stand-in for hdb that records what reaches the database.
const sent: { sql: string; params?: unknown[] }[] = [];
let failWith: string | undefined;
vi.mock("hdb", () => {
  const answer = (cb: (err: Error | null, result: unknown) => void, rows: unknown) => setImmediate(() => (failWith ? cb(new Error(failWith), undefined) : cb(null, rows)));
  return {
    default: {
      createClient: (options: { password: string }) => ({
        options,
        on: () => undefined,
        connect: (cb: (err: Error | null) => void) => answer(cb, undefined),
        exec: (sql: string, cb: (err: Error | null, rows: unknown) => void) => {
          sent.push({ sql });
          answer(cb, [{ one: 1 }]);
        },
        prepare: (sql: string, cb: (err: Error | null, statement: unknown) => void) =>
          cb(null, {
            exec: (params: unknown[], done: (err: Error | null, rows: unknown) => void) => {
              sent.push({ sql, params });
              answer(done, [{ one: 1 }]);
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

describe("SqlReader", () => {
  const user = { host: "synthetic.hana.example.com", user: "SALES#SYNTH", password: "pa55-synthetic" };
  beforeEach(() => {
    sent.length = 0;
    failWith = undefined;
  });

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
