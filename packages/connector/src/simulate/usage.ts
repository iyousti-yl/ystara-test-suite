import { refKey, type DspObject, type LineageGraph, type Pipeline } from "@ystara/shared";
import type { Cell } from "./fixtures.js";
import { SimulationStop } from "./fragment.js";
import { stepSource } from "./simulate.js";
import { tokenize } from "./sql-text.js";

/**
 * Which columns a pipeline's logic reads, worked out from each step's
 * definition alone (its SQL text or CSN query; nothing is sent), so the
 * builder can offer only the columns that matter and fill new rows with
 * values that get through:
 *
 *  - `used`: read by a filter, a join, a grouping, a sort or a calculation
 *    of some step, not only passed on to the next one;
 *  - `joined`: compared with another column (a join condition), so made-up
 *    rows give both sides the same value;
 *  - `keeps`: a value a filter keeps (`= 'OPEN'`, `IN ('A', 'B')`,
 *    `LIKE 'AB%'`, `BETWEEN 1 AND 9`), NULL for `IS NULL`;
 *  - `range`: "start" or "end" for a column compared with today's date
 *    (`VALID_FROM <= CURRENT_DATE`), so a made-up row is valid today.
 *
 * Names are matched as SAP HANA matches them: a quoted name as written, an
 * unquoted one in upper case. A step that renames a column (`EMP_ID AS
 * employeeId`) passes what is said of the new name back to the old one, so a
 * filter three steps down still marks the table's column. It is a reading by
 * name, not a full column lineage: a name that two tables share is marked in
 * both, and `SELECT *` passes every name on unchanged. Marking a column too
 * many is harmless; the builder can always show every column.
 */
export interface ColumnUsage {
  used: Set<string>;
  joined: Set<string>;
  keeps: Map<string, Cell>;
  range: Map<string, "start" | "end">;
}

export function columnUsage(graph: LineageGraph, pipeline: Pipeline): ColumnUsage {
  const nodes = new Map(graph.nodes.map((n) => [refKey(n), n]));
  const found = new Found();
  for (const step of pipeline.steps) {
    const node = nodes.get(refKey(step));
    if (node) readStep(node, found);
  }
  return found.traced();
}

/** What one SQL text or CSN query says of its columns, as columnUsage reads each step. */
export function stepColumnUsage(source: { sql: string } | { csn: unknown }): ColumnUsage {
  const found = new Found();
  if ("sql" in source) readSql(source.sql, found);
  else readCsn(source.csn, found);
  return found.traced();
}

function readStep(node: DspObject, found: Found) {
  const source = stepSource(node);
  if (!source) return;
  try {
    if ("sql" in source) readSql(source.sql, found);
    else readCsn(source.csn, found);
  } catch (e) {
    // A step the simulation can't read says nothing about its columns; the simulation says why elsewhere.
    if (!(e instanceof SimulationStop)) throw e;
  }
}

/** What the steps say, by name, before renames are traced back. */
class Found {
  used = new Set<string>();
  joined = new Set<string>();
  keeps = new Map<string, Cell>();
  range = new Map<string, "start" | "end">();
  /** For each name a step gives a column, the names it was given from. */
  renamedFrom = new Map<string, Set<string>>();

  rename(from: string, to: string) {
    if (from === to) return;
    const set = this.renamedFrom.get(to) ?? new Set<string>();
    set.add(from);
    this.renamedFrom.set(to, set);
  }
  keep(name: string, value: Cell) {
    this.used.add(name);
    // The first filter read wins; most pipelines filter a column once.
    if (!this.keeps.has(name)) this.keeps.set(name, value);
  }
  join(a: string, b: string) {
    this.used.add(a).add(b);
    this.joined.add(a).add(b);
  }
  dated(name: string, end: "start" | "end") {
    this.used.add(name);
    if (!this.range.has(name)) this.range.set(name, end);
  }

  /** Everything said of a name, also said of the names it was renamed from, however many steps back. */
  traced(): ColumnUsage {
    const back = (name: string) => {
      const seen = new Set([name]);
      const queue = [name];
      while (queue.length) {
        for (const from of this.renamedFrom.get(queue.pop()!) ?? []) {
          if (!seen.has(from)) {
            seen.add(from);
            queue.push(from);
          }
        }
      }
      return seen;
    };
    const set = (names: Set<string>) => new Set([...names].flatMap((n) => [...back(n)]));
    const map = <T>(values: Map<string, T>) => {
      const out = new Map<string, T>();
      for (const [name, value] of values) for (const n of back(name)) if (!out.has(n)) out.set(n, value);
      return out;
    };
    return { used: set(this.used), joined: set(this.joined), keeps: map(this.keeps), range: map(this.range) };
  }
}

// --- SQL text ---------------------------------------------------------------

type Token = ReturnType<typeof tokenize>[number];

const RESERVED = new Set(
  (
    "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET UNION ALL INTERSECT EXCEPT MINUS ON USING JOIN INNER LEFT RIGHT FULL OUTER " +
    "CROSS NATURAL AS AND OR NOT IN IS NULL LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT TOP WITH LATERAL WINDOW FOR INTO SET " +
    "VALUES FETCH ROWS ONLY ASC DESC NULLS FIRST LAST TRUE FALSE OVER PARTITION ESCAPE ANY SOME INTERVAL"
  ).split(" "),
);
/** Words that stand for today, in a filter that keeps rows valid today. */
const TODAY = new Set(["CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_UTCDATE", "CURRENT_UTCTIMESTAMP", "NOW", "CURRENT_TIME"]);
/** Clauses whose names are read by the step's logic. */
const LOGIC = new Set(["WHERE", "ON", "HAVING", "GROUP", "ORDER", "USING"]);
const CLAUSES = new Set(["SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "MINUS", "ON", "JOIN", "USING", "WINDOW"]);

const isName = (t: Token | undefined) => !!t && (t.kind === "quoted" || (t.kind === "word" && !RESERVED.has(t.value) && !TODAY.has(t.value)));
const isWord = (t: Token | undefined, ...words: string[]) => t?.kind === "word" && words.includes(t.value);

/**
 * The column names in a run of tokens: names that aren't a function being
 * called, a qualifier (the T of T.COL), the type of a CAST or an alias after
 * AS, the DATE of DATE '2026-01-01', nor the YEAR of EXTRACT(YEAR FROM X).
 */
function namesIn(tokens: Token[]): string[] {
  return tokens
    .filter(
      (t, i) =>
        isName(t) && tokens[i + 1]?.text !== "(" && tokens[i + 1]?.text !== "." && !isWord(tokens[i - 1], "AS") && tokens[i + 1]?.kind !== "string" && !isWord(tokens[i + 1], "FROM"),
    )
    .map((t) => t.value);
}

/**
 * Reads SQL text level by level (each subquery is a level of its own): the
 * names in its logic clauses, its select list's renames and calculations, and
 * the conditions its filters and joins hold.
 */
function readSql(sql: string, found: Found) {
  const tokens = tokenize(sql).filter((t) => t.kind !== "space" && t.text !== ";");
  let i = 0;
  // A placeholder for a subquery inside a select item or a condition: it makes the item a calculation.
  const subquery: Token = { kind: "symbol", text: "(subquery)", value: "(subquery)" };

  const level = () => {
    let clause = "";
    let depth = 0;
    let part: Token[] = [];
    const flush = () => {
      if (clause === "SELECT") selectItem(part, found);
      else if (LOGIC.has(clause)) condition(part, found);
      part = [];
    };
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.text === "(") {
        if (isWord(tokens[i + 1], "SELECT")) {
          i++;
          level();
          part.push(subquery);
          continue;
        }
        depth++;
      } else if (t.text === ")") {
        if (depth === 0) {
          flush();
          i++;
          return;
        }
        depth--;
      } else if (t.kind === "word" && CLAUSES.has(t.value) && (depth === 0 || (["JOIN", "ON", "USING"].includes(t.value) && ["FROM", "JOIN", "ON"].includes(clause)))) {
        // A clause starts; JOIN and ON also inside a join group: FROM (a JOIN b ON ...).
        flush();
        clause = t.value;
        i++;
        continue;
      } else if (t.text === "," && depth === 0 && clause === "SELECT") {
        flush();
        i++;
        continue;
      }
      part.push(t);
      i++;
    }
    flush();
  };
  while (i < tokens.length) level();
}

/** One item of a select list: a column passed on (perhaps renamed), *, or a calculation whose names are all read. */
function selectItem(tokens: Token[], found: Found) {
  let item = tokens;
  while (isWord(item[0], "DISTINCT", "ALL")) item = item.slice(1);
  if (isWord(item[0], "TOP") && item[1]?.kind === "number") item = item.slice(2);
  if (!item.length) return;

  let alias: Token | undefined;
  let expr = item;
  if (item.length >= 3 && isWord(item.at(-2), "AS") && isName(item.at(-1))) {
    alias = item.at(-1);
    expr = item.slice(0, -2);
  } else if (item.length >= 2 && isName(item.at(-1)) && item.at(-2)?.text !== ".") {
    alias = item.at(-1);
    expr = item.slice(0, -1);
  }
  const column = expr.length === 1 ? expr[0] : expr.length === 3 && expr[1].text === "." ? expr[2] : undefined;
  if (column?.text === "*") return;
  if (column && isName(column)) {
    if (alias) found.rename(column.value, alias.value);
    return;
  }
  // A calculation reads all its names, and its CASE branches compare like a filter: WHEN "KIND" = 'P'.
  condition(expr, found);
}

/**
 * A WHERE, ON or HAVING condition (or GROUP BY, ORDER BY, USING): every name
 * in it is read, and the comparisons it holds say which values get through.
 */
function condition(tokens: Token[], found: Found) {
  for (const name of namesIn(tokens)) found.used.add(name);

  /** The column at k (COL or T.COL): its name and the index after it. */
  const columnAt = (k: number): { name: string; next: number } | undefined => {
    const t = tokens[k];
    if (!isName(t) || tokens[k + 1]?.text === "(" || tokens[k + 1]?.kind === "string" || isWord(tokens[k - 1], "AS")) return undefined;
    if (tokens[k + 1]?.text === "." && isName(tokens[k + 2])) return { name: tokens[k + 2].value, next: k + 3 };
    if (tokens[k - 1]?.text === ".") return undefined;
    return { name: t.value, next: k + 1 };
  };
  /** A value written in the SQL at k: 'text', 12, -1.5, DATE '2026-01-01'. */
  const valueAt = (k: number): { value: Cell; next: number } | undefined => {
    let at = k;
    if (isWord(tokens[at], "DATE", "TIMESTAMP", "TIME", "SECONDDATE") && tokens[at + 1]?.kind === "string") at++;
    const t = tokens[at];
    if (t?.kind === "string") return { value: t.value, next: at + 1 };
    if (t?.kind === "number") return { value: Number(t.text), next: at + 1 };
    if (t?.text === "-" && tokens[at + 1]?.kind === "number") return { value: -Number(tokens[at + 1].text), next: at + 2 };
    return undefined;
  };
  /** Today at k (CURRENT_DATE, NOW()): the index after it. */
  const todayAt = (k: number): number | undefined => {
    if (tokens[k]?.kind !== "word" || !TODAY.has(tokens[k].value)) return undefined;
    return tokens[k + 1]?.text === "(" && tokens[k + 2]?.text === ")" ? k + 3 : k + 1;
  };
  /** The comparison operator at k: =, <>, <, <=, >, >= (the tokenizer gives one symbol per character). */
  const operatorAt = (k: number): { op: string; next: number } | undefined => {
    const a = tokens[k]?.text;
    const b = tokens[k + 1]?.text;
    if ((a === "<" || a === ">" || a === "!") && (b === "=" || (a === "<" && b === ">"))) return { op: a + b, next: k + 2 };
    if (a === "=" || a === "<" || a === ">") return { op: a, next: k + 1 };
    return undefined;
  };
  const flip: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

  for (let k = 0; k < tokens.length; k++) {
    const left = columnAt(k);
    if (left) {
      const op = operatorAt(left.next);
      if (op) {
        const right = columnAt(op.next);
        const value = valueAt(op.next);
        if (op.op === "=" && right) found.join(left.name, right.name);
        else if (op.op === "=" && value) found.keep(left.name, value.value);
        else if (todayAt(op.next) !== undefined && op.op !== "=" && op.op !== "<>" && op.op !== "!=") found.dated(left.name, op.op.startsWith("<") ? "start" : "end");
        continue;
      }
      if (isWord(tokens[left.next], "IN") && tokens[left.next + 1]?.text === "(") {
        const first = valueAt(left.next + 2);
        if (first) found.keep(left.name, first.value);
        continue;
      }
      if (isWord(tokens[left.next], "IS") && isWord(tokens[left.next + 1], "NULL")) {
        found.keep(left.name, null);
        continue;
      }
      if (isWord(tokens[left.next], "LIKE") && tokens[left.next + 1]?.kind === "string") {
        found.keep(left.name, likeExample(tokens[left.next + 1].value));
        continue;
      }
      if (isWord(tokens[left.next], "BETWEEN")) {
        const low = valueAt(left.next + 1);
        if (low) found.keep(left.name, low.value);
        continue;
      }
    }
    // A value or today on the left: 'OPEN' = STATUS, CURRENT_DATE <= VALID_TO, CURRENT_DATE BETWEEN FROM_DATE AND TO_DATE.
    const value = valueAt(k);
    const today = todayAt(k);
    if (value || today !== undefined) {
      const after = value ? value.next : today!;
      const op = operatorAt(after);
      const right = op && columnAt(op.next);
      if (op && right) {
        if (value && op.op === "=") found.keep(right.name, value.value);
        else if (!value && op.op !== "=" && op.op !== "<>" && op.op !== "!=") found.dated(right.name, flip[op.op]?.startsWith("<") ? "start" : "end");
      } else if (!value && isWord(tokens[after], "BETWEEN")) {
        const from = columnAt(after + 1);
        const to = from && isWord(tokens[from.next], "AND") ? columnAt(from.next + 1) : undefined;
        if (from) found.dated(from.name, "start");
        if (to) found.dated(to.name, "end");
      }
    }
  }
}

/** A value a LIKE pattern keeps: its % parts left out, each _ an X. */
const likeExample = (pattern: string) => pattern.replace(/%/g, "").replace(/_/g, "X");

// --- CSN query (graphical views) ---------------------------------------------

type Csn = Record<string, unknown>;
const isObject = (v: unknown): v is Csn => !!v && typeof v === "object" && !Array.isArray(v);
const refName = (v: unknown) => (isObject(v) && Array.isArray(v.ref) && typeof v.ref.at(-1) === "string" ? (v.ref.at(-1) as string) : undefined);

/** Every column name an expression reads, at any depth. */
function refsIn(e: unknown, out: string[] = []): string[] {
  if (Array.isArray(e)) for (const x of e) refsIn(x, out);
  else if (isObject(e)) {
    const name = refName(e);
    if (name) out.push(name);
    else for (const v of Object.values(e)) refsIn(v, out);
  }
  return out;
}

function readCsn(query: unknown, found: Found) {
  if (!isObject(query)) return;
  if (isObject(query.SET)) {
    for (const q of Array.isArray(query.SET.args) ? query.SET.args : []) readCsn(q, found);
    return;
  }
  const s = isObject(query.SELECT) ? query.SELECT : undefined;
  if (!s) return;
  for (const c of Array.isArray(s.columns) ? s.columns : []) {
    if (!isObject(c)) continue;
    const name = refName(c);
    if (name && !c.func && !c.xpr) {
      found.rename(name, typeof c.as === "string" ? c.as : name);
      continue;
    }
    for (const sub of subqueries(c)) readCsn(sub, found);
    for (const n of refsIn(c)) found.used.add(n);
  }
  readFrom(s.from, found);
  for (const clause of [s.where, s.having]) if (Array.isArray(clause)) csnCondition(clause, found);
  for (const clause of [s.groupBy, s.orderBy]) for (const n of refsIn(clause)) found.used.add(n);
}

function readFrom(f: unknown, found: Found) {
  if (!isObject(f)) return;
  if (isObject(f.SELECT) || isObject(f.SET)) return readCsn(f, found);
  for (const side of Array.isArray(f.args) ? f.args : []) readFrom(side, found);
  if (Array.isArray(f.on)) csnCondition(f.on, found);
}

/** Queries nested in an expression (EXISTS, a scalar subquery), each read as a query of its own. */
function subqueries(e: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(e)) for (const x of e) subqueries(x, out);
  else if (isObject(e)) {
    if (isObject(e.SELECT) || isObject(e.SET)) out.push(e);
    else for (const v of Object.values(e)) subqueries(v, out);
  }
  return out;
}

/** A condition in CQN's token list form: [{ref}, "=", {val}, "and", ...]. */
function csnCondition(list: unknown[], found: Found) {
  for (const sub of subqueries(list)) readCsn(sub, found);
  for (const n of refsIn(list.filter((x) => !(isObject(x) && (isObject(x.SELECT) || isObject(x.SET)))))) found.used.add(n);
  const op = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : undefined);
  const val = (x: unknown): Cell | undefined => (isObject(x) && "val" in x && (x.val === null || ["string", "number", "boolean"].includes(typeof x.val)) ? (x.val as Cell) : undefined);
  const today = (x: unknown) => isObject(x) && ((typeof x.func === "string" && TODAY.has(x.func.toUpperCase())) || (Array.isArray(x.ref) && x.ref.length === 1 && x.ref[0] === "$now"));
  for (let k = 0; k < list.length; k++) {
    const x = list[k];
    if (isObject(x) && Array.isArray(x.xpr)) csnCondition(x.xpr, found);
    const left = refName(x);
    const o = op(list[k + 1]);
    const right = list[k + 2];
    if (left && o) {
      if (o === "=" && refName(right)) found.join(left, refName(right)!);
      else if (o === "=" && val(right) !== undefined) found.keep(left, val(right)!);
      else if (o === "in" && isObject(right) && Array.isArray(right.list) && val(right.list[0]) !== undefined) found.keep(left, val(right.list[0])!);
      else if (o === "is" && op(right) === "null") found.keep(left, null);
      else if (o === "is null") found.keep(left, null);
      else if (o === "like" && typeof val(right) === "string") found.keep(left, likeExample(val(right) as string));
      else if (o === "between" && val(right) !== undefined) found.keep(left, val(right)!);
      else if (["<", "<="].includes(o) && today(right)) found.dated(left, "start");
      else if ([">", ">="].includes(o) && today(right)) found.dated(left, "end");
    } else if (o && refName(right)) {
      if (o === "=" && val(x) !== undefined) found.keep(refName(right)!, val(x)!);
      else if (["<", "<="].includes(o) && today(x)) found.dated(refName(right)!, "end");
      else if ([">", ">="].includes(o) && today(x)) found.dated(refName(right)!, "start");
    } else if (today(x) && o === "between") {
      const from = refName(list[k + 2]);
      const to = op(list[k + 3]) === "and" ? refName(list[k + 4]) : undefined;
      if (from) found.dated(from, "start");
      if (to) found.dated(to, "end");
    }
  }
}
