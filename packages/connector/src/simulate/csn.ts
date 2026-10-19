import { quoteIdentifier } from "../sql.js";
import { hanaType } from "./fixtures.js";
import { concat, fragment, SimulationStop, type Fragment } from "./fragment.js";

/**
 * Compiles the CSN query of a graphical view (`definitions.<view>.query`, in
 * CQN: SELECT with from, columns, where, ...; SET for unions) into SAP HANA
 * SQL, with each object it reads replaced by a subquery from `resolve`
 * (a fixture or an upstream step), so the result reads nothing but DUMMY.
 *
 * This first version covers what a projection, join, filter, calculated
 * column, aggregation and union produce. Anything else (input parameters,
 * associations followed in a path, ...) stops the run with a sentence
 * naming the construct, so a spike run lists what is still missing.
 */

type Csn = Record<string, unknown>;
type Resolve = (name: string[]) => Fragment;

const isObject = (v: unknown): v is Csn => !!v && typeof v === "object" && !Array.isArray(v);
const keysOf = (v: Csn) => Object.keys(v).join(", ");

export function compileCsnQuery(query: unknown, resolve: Resolve): Fragment {
  if (!isObject(query)) throw new SimulationStop("its query is missing");
  if (isObject(query.SELECT)) return select(query.SELECT, resolve);
  if (isObject(query.SET)) return set(query.SET, resolve);
  throw new SimulationStop(`its query is neither a SELECT nor a SET (${keysOf(query)})`);
}

const SELECT_KEYS = new Set(["from", "columns", "where", "groupBy", "having", "orderBy", "limit", "distinct"]);

function select(s: Csn, resolve: Resolve): Fragment {
  const unknown = Object.keys(s).filter((k) => !SELECT_KEYS.has(k));
  if (unknown.length) throw new SimulationStop(`its query uses ${unknown.join(", ")}, which the simulation can't compile yet`);
  const parts: (string | Fragment)[] = ["SELECT ", s.distinct ? "DISTINCT " : ""];
  parts.push(Array.isArray(s.columns) && s.columns.length ? concat(s.columns.map((c) => column(c, resolve)), ", ") : "*");
  parts.push(" FROM ", from(s.from, resolve));
  if (Array.isArray(s.where) && s.where.length) parts.push(" WHERE ", xpr(s.where, resolve));
  if (Array.isArray(s.groupBy) && s.groupBy.length) parts.push(" GROUP BY ", concat(s.groupBy.map((g) => expr(g, resolve)), ", "));
  if (Array.isArray(s.having) && s.having.length) parts.push(" HAVING ", xpr(s.having, resolve));
  if (Array.isArray(s.orderBy) && s.orderBy.length) parts.push(" ORDER BY ", orderBy(s.orderBy, resolve));
  if (s.limit !== undefined) parts.push(limit(s.limit));
  return concat(parts);
}

const SET_OPERATORS: Record<string, string> = { union: "UNION", intersect: "INTERSECT", except: "EXCEPT", minus: "EXCEPT" };

/** A union (or intersect, except) of queries. Each side is wrapped, so its own ORDER BY or LIMIT stays its own. */
function set(s: Csn, resolve: Resolve): Fragment {
  const op = typeof s.op === "string" ? SET_OPERATORS[s.op.toLowerCase()] : undefined;
  if (!op) throw new SimulationStop(`its query combines queries with ${String(s.op)}, which the simulation can't compile yet`);
  if (!Array.isArray(s.args) || s.args.length < 2) throw new SimulationStop(`its ${op} has fewer than two queries`);
  const combined = concat(
    s.args.map((q, i) => concat(["SELECT * FROM (", compileCsnQuery(q, resolve), `) AS "_${i + 1}"`])),
    ` ${op}${s.all ? " ALL" : ""} `,
  );
  if (!s.orderBy && s.limit === undefined) return combined;
  const parts: (string | Fragment)[] = ["SELECT * FROM (", combined, ') AS "_SET"'];
  if (Array.isArray(s.orderBy) && s.orderBy.length) parts.push(" ORDER BY ", orderBy(s.orderBy, resolve));
  if (s.limit !== undefined) parts.push(limit(s.limit));
  return concat(parts);
}

const JOINS: Record<string, string> = { inner: "INNER JOIN", left: "LEFT OUTER JOIN", right: "RIGHT OUTER JOIN", full: "FULL OUTER JOIN", cross: "CROSS JOIN" };

function from(f: unknown, resolve: Resolve): Fragment {
  if (!isObject(f)) throw new SimulationStop("its query reads from nothing");
  if (Array.isArray(f.ref)) {
    const name = f.ref.map((part) => {
      if (typeof part !== "string") throw new SimulationStop("its query passes parameters or a filter to an object it reads, which the simulation can't compile yet");
      return part;
    });
    const alias = typeof f.as === "string" ? f.as : name.at(-1)!;
    return concat(["(", resolve(name), ") AS ", quoteIdentifier(alias)]);
  }
  if (typeof f.join === "string") {
    const join = JOINS[f.join.toLowerCase()];
    if (!join) throw new SimulationStop(`its query uses a ${f.join} join, which the simulation can't compile yet`);
    if (!Array.isArray(f.args) || f.args.length !== 2) throw new SimulationStop("its query has a join that doesn't have exactly two sides");
    // A join on the left reads on as is (a JOIN b ON .. JOIN c ON ..); one on the right goes in parentheses.
    const [left, right] = f.args;
    const rightSide = from(right, resolve);
    const parts: (string | Fragment)[] = [from(left, resolve), ` ${join} `, isObject(right) && typeof right.join === "string" ? concat(["(", rightSide, ")"]) : rightSide];
    if (Array.isArray(f.on) && f.on.length) parts.push(" ON ", xpr(f.on, resolve));
    return concat(parts);
  }
  if (isObject(f.SELECT) || isObject(f.SET)) {
    const sub = concat(["(", compileCsnQuery(f, resolve), ")"]);
    return typeof f.as === "string" ? concat([sub, " AS ", quoteIdentifier(f.as)]) : sub;
  }
  throw new SimulationStop(`its query reads from something the simulation can't compile yet (${keysOf(f)})`);
}

function column(c: unknown, resolve: Resolve): Fragment {
  if (c === "*") return fragment("*");
  if (!isObject(c)) throw new SimulationStop("its query has a column that is neither * nor an expression");
  if (c.expand || c.inline) throw new SimulationStop("its query expands an association, which the simulation can't compile yet");
  if (c.excluding) throw new SimulationStop("its query uses * excluding, which the simulation can't compile yet");
  const value = expr(c, resolve);
  return typeof c.as === "string" ? concat([value, " AS ", quoteIdentifier(c.as)]) : value;
}

/** The operators and keywords a CQN expression may hold; anything else stops the run rather than going into the SQL. */
const OPERATORS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "||", "%", ","]);
const KEYWORDS = new Set(
  "AND OR NOT IS NULL IN LIKE ESCAPE BETWEEN EXISTS CASE WHEN THEN ELSE END ASC DESC NULLS FIRST LAST DISTINCT ALL ANY SOME OVER PARTITION BY ORDER ROWS RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT ROW".split(
    " ",
  ),
);
const isToken = (t: string) => OPERATORS.has(t) || t.split(/\s+/).every((word) => KEYWORDS.has(word.toUpperCase()));

/** An expression in CQN's token list form: [ref, "=", val, "and", ...]. */
function xpr(list: unknown[], resolve: Resolve): Fragment {
  return concat(
    list.map((t) => {
      if (typeof t === "string") {
        if (!isToken(t)) throw new SimulationStop(`its query has the token ${JSON.stringify(t)}, which the simulation doesn't write into SQL`);
        return t.toUpperCase();
      }
      return expr(t, resolve);
    }),
    " ",
  );
}

function expr(e: unknown, resolve: Resolve): Fragment {
  if (!isObject(e)) {
    if (e === "*") return fragment("*");
    throw new SimulationStop("its query has an expression the simulation can't compile yet");
  }
  const value = bare(e, resolve);
  return isObject(e.cast) ? concat(["CAST(", value, ` AS ${castType(e.cast)})`]) : value;
}

function bare(e: Csn, resolve: Resolve): Fragment {
  if (e.param) throw new SimulationStop("its query uses an input parameter, which the simulation can't compile yet");
  if (Array.isArray(e.ref)) {
    if (e.ref.some((p) => typeof p !== "string")) throw new SimulationStop("its query follows a path with a filter, which the simulation can't compile yet");
    return fragment(e.ref.map((p) => quoteIdentifier(p as string)).join("."));
  }
  if ("val" in e) return fragment(literal(e.val, e.literal));
  if (typeof e.func === "string") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.func)) throw new SimulationStop(`its query calls ${JSON.stringify(e.func)}, which isn't a function name`);
    if (e.args !== undefined && !Array.isArray(e.args)) throw new SimulationStop(`its query calls ${e.func} with named arguments, which the simulation can't compile yet`);
    const args = (e.args ?? []) as unknown[];
    return concat([`${e.func.toUpperCase()}(`, concat(args.map((a) => expr(a, resolve)), ", "), ")"]);
  }
  if (Array.isArray(e.xpr)) return concat(["(", xpr(e.xpr, resolve), ")"]);
  if (Array.isArray(e.list)) return concat(["(", concat(e.list.map((x) => expr(x, resolve)), ", "), ")"]);
  if (isObject(e.SELECT) || isObject(e.SET)) return concat(["(", compileCsnQuery(e, resolve), ")"]);
  if ("#" in e) throw new SimulationStop("its query uses an enum value, which the simulation can't compile yet");
  throw new SimulationStop(`its query has an expression the simulation can't compile yet (${keysOf(e)})`);
}

/** A value written in the view's own definition (not a fixture value, which is always bound). */
function literal(v: unknown, kind: unknown): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") {
    const text = `'${v.replace(/'/g, "''")}'`;
    if (kind === "date") return `DATE${text}`;
    if (kind === "time") return `TIME${text}`;
    if (kind === "timestamp") return `TIMESTAMP${text}`;
    return text;
  }
  throw new SimulationStop("its query has a value of a kind the simulation can't write yet");
}

function castType(cast: Csn): string {
  const type = hanaType(cast as Parameters<typeof hanaType>[0]);
  if (!type) throw new SimulationStop(`its query casts to ${String(cast.type)}, a type the simulation doesn't know yet`);
  return type;
}

function orderBy(list: unknown[], resolve: Resolve): Fragment {
  return concat(
    list.map((o) => {
      const sort = isObject(o) && typeof o.sort === "string" && /^(asc|desc)$/i.test(o.sort) ? ` ${o.sort.toUpperCase()}` : "";
      const nulls = isObject(o) && typeof o.nulls === "string" && /^(first|last)$/i.test(o.nulls) ? ` NULLS ${o.nulls.toUpperCase()}` : "";
      return concat([expr(o, resolve), sort, nulls]);
    }),
    ", ",
  );
}

function limit(l: unknown): string {
  const n = (v: unknown) => (isObject(v) && Number.isInteger(v.val) && (v.val as number) >= 0 ? (v.val as number) : undefined);
  const rows = isObject(l) ? n(l.rows) : undefined;
  if (rows === undefined) throw new SimulationStop("its query has a LIMIT the simulation can't read");
  const offset = isObject(l) && l.offset !== undefined ? n(l.offset) : 0;
  if (offset === undefined) throw new SimulationStop("its query has an OFFSET the simulation can't read");
  return ` LIMIT ${rows}${offset ? ` OFFSET ${offset}` : ""}`;
}
