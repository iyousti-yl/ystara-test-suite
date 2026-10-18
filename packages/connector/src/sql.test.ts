import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertSelectOnly, NotSelectError } from "./readonly.js";
import { checkDatabaseUser, columnMetrics, measureObject, metricsQuery, quoteIdentifier, SqlReader, sumScale } from "./sql.js";

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
    expect(columnMetrics("DECIMAL")).toEqual(["nonNull", "distinct", "minHash", "maxHash", "sum", "sumHash"]);
    expect(columnMetrics("date")).toEqual(["nonNull", "distinct", "minHash", "maxHash"]);
    expect(columnMetrics("NVARCHAR")).toEqual(["nonNull", "distinct", "minHash", "maxHash"]);
    expect(columnMetrics("BOOLEAN")).toEqual(["nonNull", "distinct"]);
    expect(columnMetrics("NCLOB")).toEqual(["nonNull"]);
  });

  it("takes sums exactly: integers and DECIMAL(p,s) at their scale, floating types at 6 decimals", () => {
    expect(sumScale("INTEGER", 0)).toEqual({ scale: 0, floating: false });
    expect(sumScale("BIGINT", null)).toEqual({ scale: 0, floating: false });
    expect(sumScale("DECIMAL", 2)).toEqual({ scale: 2, floating: false });
    expect(sumScale("decimal", 6)).toEqual({ scale: 6, floating: false });
    for (const [type, scale] of [["DECIMAL", null], ["DECIMAL", undefined], ["DOUBLE", null], ["REAL", null], ["SMALLDECIMAL", null], ["DECIMAL", 32767]] as const) {
      expect(sumScale(type, scale), `${type} ${scale}`).toEqual({ scale: 6, floating: true });
    }
    expect(sumScale("NVARCHAR", null)).toBeUndefined();
  });
});

const salt = "ab".repeat(32);

describe("metricsQuery", () => {
  it("measures a view in one SELECT that passes the read-only guard, with min and max only as salted hashes", () => {
    const { sql, columns } = metricsQuery(
      "SALES",
      "ORDERS_SYNTH_V",
      [
        { name: "ORDER_ID", dataType: "NVARCHAR" },
        { name: "AMOUNT", dataType: "DECIMAL", scale: 2 },
        { name: 'ODD"NAME;--', dataType: "NCLOB" },
      ],
      salt,
    );
    const hashed = (value: string) => `hash_sha256(hextobin('${salt}'), to_binary(to_nvarchar(${value})))`;
    expect(sql).toBe(
      'select count(*) as "rows", ' +
        `count("ORDER_ID") as "c0_nonNull", count(distinct "ORDER_ID") as "c0_distinct", ${hashed('min("ORDER_ID")')} as "c0_minHash", ${hashed('max("ORDER_ID")')} as "c0_maxHash", ` +
        `count("AMOUNT") as "c1_nonNull", count(distinct "AMOUNT") as "c1_distinct", ${hashed('min("AMOUNT")')} as "c1_minHash", ${hashed('max("AMOUNT")')} as "c1_maxHash", ` +
        `case when count(*) >= 10 then sum("AMOUNT") end as "c1_sum", case when count(*) < 10 then ${hashed('sum("AMOUNT")')} end as "c1_sumHash", ` +
        'count("ODD""NAME;--") as "c2_nonNull" from "SALES"."ORDERS_SYNTH_V"',
    );
    expect(sql).not.toMatch(/\b(min|max)\("[^"]*"\) as/);
    expect(() => assertSelectOnly(sql)).not.toThrow();
    expect(columns.map((c) => c.metrics.length)).toEqual([4, 6, 1]);
  });

  it("sums floating columns at a fixed scale, so the order HANA adds rows in can't change the last digits", () => {
    const { sql, columns } = metricsQuery(
      "SALES",
      "ORDERS_SYNTH_V",
      [
        { name: "RATE", dataType: "DOUBLE", scale: null },
        { name: "SHARE", dataType: "DECIMAL", scale: null },
        { name: "QTY", dataType: "INTEGER", scale: 0 },
      ],
      salt,
    );
    const hashed = (value: string) => `hash_sha256(hextobin('${salt}'), to_binary(to_nvarchar(${value})))`;
    for (const [i, c] of [[0, "RATE"], [1, "SHARE"]] as const) {
      expect(sql).toContain(`case when count(*) >= 10 then sum(cast("${c}" as decimal(38, 6))) end as "c${i}_sum"`);
      expect(sql).toContain(`case when count(*) < 10 then ${hashed(`sum(cast("${c}" as decimal(38, 6)))`)} end as "c${i}_sumHash"`);
    }
    expect(sql).toContain('case when count(*) >= 10 then sum("QTY") end as "c2_sum"');
    expect(() => assertSelectOnly(sql)).not.toThrow();
    expect(columns.map((c) => c.sum)).toEqual([
      { scale: 6, floating: true },
      { scale: 6, floating: true },
      { scale: 0, floating: false },
    ]);
  });

  it("writes nothing but a hex salt into the statement", () => {
    for (const bad of ["", "AB".repeat(32), "ab".repeat(31), `${"ab".repeat(31)}')`]) {
      expect(() => metricsQuery("SALES", "ORDERS_SYNTH_V", [{ name: "A", dataType: "DATE" }], bad), bad).toThrow("salt");
    }
  });
});

describe("measureObject", () => {
  const hash = (byte: string) => Buffer.from(byte.repeat(32), "hex");

  it("reads the columns, then every measure in one pass: counts, hashes in hex and sums as text", async () => {
    rowsFor = (sql) =>
      sql.includes("view_columns")
        ? [
            { name: "ORDER_ID", dataType: "NVARCHAR", scale: null },
            { name: "AMOUNT", dataType: "DECIMAL", scale: 2 },
          ]
        : [{ rows: 24, c0_nonNull: 24, c0_distinct: 24, c0_minHash: hash("01"), c0_maxHash: hash("02"), c1_nonNull: 20, c1_distinct: 7, c1_minHash: hash("03"), c1_maxHash: hash("04"), c1_sum: "1234.50", c1_sumHash: null }];
    const sql = await SqlReader.connect(user);
    expect(await measureObject(sql, "SALES", { name: "ORDERS_SYNTH_V", type: "VIEW" }, salt)).toEqual({
      rows: 24,
      columns: [
        { name: "ORDER_ID", dataType: "NVARCHAR", nonNull: 24, distinct: 24, minHash: "01".repeat(32), maxHash: "02".repeat(32) },
        { name: "AMOUNT", dataType: "DECIMAL", nonNull: 20, distinct: 7, minHash: "03".repeat(32), maxHash: "04".repeat(32), sum: "1234.50", sumHash: null, sumScale: 2 },
      ],
    });
    expect(sent.filter((s) => s.sql !== "(dropped)").map((s) => s.params)).toEqual([["SALES", "ORDERS_SYNTH_V"], undefined]);
  });

  it("reads a table's columns from table_columns, and keeps an empty object's hashes empty", async () => {
    rowsFor = (sql) =>
      sql.includes("table_columns") ? [{ name: "DAY", dataType: "DATE", scale: null }] : [{ rows: 0, c0_nonNull: 0, c0_distinct: 0, c0_minHash: null, c0_maxHash: null }];
    const sql = await SqlReader.connect(user);
    expect(await measureObject(sql, "SALES", { name: "CALENDAR_SYNTH", type: "TABLE" }, salt)).toEqual({
      rows: 0,
      columns: [{ name: "DAY", dataType: "DATE", nonNull: 0, distinct: 0, minHash: null, maxHash: null }],
    });
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
