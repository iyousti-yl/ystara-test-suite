import { quoteIdentifier } from "../sql.js";
import { concat, SimulationStop, type Fragment } from "./fragment.js";

/**
 * SQL text of a SQL view or a transformation flow's SQL step, with every
 * object it reads replaced by what stands for it in a simulation: a fixture
 * or the compiled SQL of an upstream step, as a subquery.
 *
 *   FROM "LT_EMPLOYEE_RAW" r      ->  FROM (SELECT CAST(? AS ...) ... FROM DUMMY UNION ALL ...) r
 *   JOIN "HR"."LT_ORG_DIM"        ->  JOIN (...) AS "LT_ORG_DIM"
 *
 * An object is replaced where SQL reads it: right after FROM or JOIN, or
 * after a comma in a FROM list. A name in any other place is a column
 * qualifier ("LT_ORG_DIM"."ORG_ID", left alone, since the subquery keeps the
 * name as its alias) or something the simulation can't place, which stops the
 * run: the composed query must never read a real object. Comments are
 * dropped, because the read-only guard refuses them.
 */

type Kind = "space" | "string" | "quoted" | "word" | "number" | "symbol";
interface Token {
  kind: Kind;
  text: string;
  /** Words in upper case (as SQL folds them), quoted identifiers without their quotes. */
  value: string;
}

/** Words that are never a name or an alias where this code looks for one. */
const RESERVED = new Set(
  (
    "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET UNION ALL INTERSECT EXCEPT MINUS ON USING JOIN INNER LEFT RIGHT FULL OUTER " +
    "CROSS NATURAL AS AND OR NOT IN IS NULL LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT TOP WITH LATERAL WINDOW FOR INTO SET " +
    "VALUES FETCH ROWS ONLY ASC DESC NULLS FIRST LAST"
  ).split(" "),
);

/** Words that start a clause, which decides what a comma separates. */
const CLAUSES = new Set(["SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "MINUS", "ON", "JOIN", "USING", "WINDOW"]);

/** Clauses in which a comma separates objects read. */
const FROM_LIST = new Set(["FROM", "JOIN", "ON", "USING"]);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Kind, text: string, value = text) => tokens.push({ kind, text, value });
  while (i < sql.length) {
    const c = sql[i];
    const rest = sql.slice(i);
    if (/\s/.test(c)) {
      const m = /^\s+/.exec(rest)![0];
      push("space", m);
      i += m.length;
    } else if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      push("space", " ");
    } else if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new SimulationStop("its SQL has a comment that isn't closed");
      i = end + 2;
      push("space", " ");
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      if (j >= sql.length) throw new SimulationStop("its SQL has a quote that isn't closed");
      const text = sql.slice(i, j + 1);
      push(c === "'" ? "string" : "quoted", text, text.slice(1, -1).split(c + c).join(c));
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(rest)![0];
      push("word", m, m.toUpperCase());
      i += m.length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(rest)![0];
      push("number", m);
      i += m.length;
    } else {
      push("symbol", c);
      i++;
    }
  }
  return tokens;
}

const isName = (t: Token | undefined) => !!t && (t.kind === "quoted" || (t.kind === "word" && !RESERVED.has(t.value)));
const isWord = (t: Token | undefined, word: string) => t?.kind === "word" && t.value === word;

/** The significant tokens of `sql` (no spaces, no comments, no final semicolon), by position. */
function significant(sql: string) {
  const tokens = tokenize(sql);
  while (tokens.length && (tokens.at(-1)!.kind === "space" || tokens.at(-1)!.text === ";")) tokens.pop();
  const sig = tokens.map((_, i) => i).filter((i) => tokens[i].kind !== "space");
  const at = (k: number) => (k >= 0 && k < sig.length ? tokens[sig[k]] : undefined);
  return { tokens, sig, at };
}

/**
 * The places (indexes of significant tokens) where SQL reads an object:
 * right after the FROM of a SELECT, after JOIN, after a comma in a FROM list
 * (also after a join's condition: FROM a JOIN b ON .., c), and first inside
 * the parentheses of a join group: FROM (a JOIN b ON ..). FROM inside a
 * function's parentheses (EXTRACT(YEAR FROM x), TRIM(' ' FROM x)) reads
 * nothing: only a FROM at the depth of a SELECT counts.
 */
function readPlaces(at: (k: number) => Token | undefined, count: number): Set<number> {
  const places = new Set<number>();
  const clause: string[] = [""];
  const clauseFrom = new Set<number>();
  const groups = new Set<number>();
  for (let k = 0; k < count; k++) {
    const t = at(k)!;
    const before = at(k - 1);
    const place =
      (isWord(before, "FROM") && clauseFrom.has(k - 1)) ||
      isWord(before, "JOIN") ||
      (before?.text === "," && FROM_LIST.has(clause.at(-1)!)) ||
      (before?.text === "(" && groups.has(k - 1));
    if (place) places.add(k);
    if (t.text === "(") {
      clause.push("");
      // A parenthesis where an object is read opens a subquery, or else a join group.
      if (place && !isWord(at(k + 1), "SELECT")) {
        groups.add(k);
        clause[clause.length - 1] = "FROM";
      }
    } else if (t.text === ")") {
      if (clause.length > 1) clause.pop();
    } else if (isWord(t, "FROM")) {
      if (clause.at(-1) === "SELECT") {
        clauseFrom.add(k);
        clause[clause.length - 1] = "FROM";
      }
    } else if (t.kind === "word" && CLAUSES.has(t.value)) {
      clause[clause.length - 1] = t.value;
    }
  }
  return places;
}

/**
 * Stops unless every place where `sql` reads an object holds a subquery or
 * DUMMY: the last check on each compiled step before it can be sent, whatever
 * produced it (SQL text or a CSN query).
 */
export function assertReadsOnlyDummy(sql: string): void {
  const { sig, at } = significant(sql);
  for (const k of readPlaces(at, sig.length)) {
    const t = at(k)!;
    if (t.text === "(") continue;
    const name = at(k + 1)?.text === "." && isName(at(k + 2)) ? `${t.value}.${at(k + 2)!.value}` : t.value;
    if (name !== "DUMMY" && name !== "SYS.DUMMY") throw new SimulationStop(`the compiled SQL would read ${name} itself, so it is not sent`);
  }
}

/**
 * `resolve` returns what replaces an object (by its name as written: one part,
 * or SPACE and NAME), or undefined for a name that is no object of the scan.
 * It throws SimulationStop for an object the run can't stand in for.
 * `isKnown` says whether a name is any object of the scan, inside the
 * pipeline or not, for the check that nothing real is left.
 */
export function inlineReferences(sql: string, resolve: (name: string[]) => Fragment | undefined, isKnown: (name: string[]) => boolean): Fragment {
  const { tokens, sig, at } = significant(sql);

  if (isWord(at(0), "WITH")) throw new SimulationStop("its SQL starts with WITH, which the read-only guard refuses (a later change can allow it)");
  if (!isWord(at(0), "SELECT")) throw new SimulationStop("its SQL isn't a single SELECT (SQLScript can't be inlined yet)");
  if (tokens.some((t) => t.text === ";")) throw new SimulationStop("its SQL holds more than one statement");
  if (tokens.some((t) => t.text === "?")) throw new SimulationStop("its SQL has ? placeholders");

  /** Replacements by the index (in `sig`) of the name's first token: how many tokens they take, and what goes in. */
  const replaced = new Map<number, { span: number; with: Fragment }>();
  /** Significant tokens that are a replaced name or its alias. */
  const handled = new Set<number>();
  const places = readPlaces(at, sig.length);

  for (let k = 0; k < sig.length; k++) {
    const t = at(k)!;
    if (!places.has(k)) continue;
    if (!isName(t)) {
      if (t.text !== "(") throw new SimulationStop(`it reads from ${t.text}, which the simulation can't place`);
      continue;
    }

    const parts = [t.value];
    let end = k;
    if (at(k + 1)?.text === "." && isName(at(k + 2))) {
      parts.push(at(k + 2)!.value);
      end = k + 2;
    }
    const shown = parts.join(".");
    if (at(end + 1)?.text === "(") throw new SimulationStop(`it calls ${shown} with parameters, which can't be inlined yet`);
    if (shown === "DUMMY" || shown === "SYS.DUMMY") {
      for (let j = k; j <= end; j++) handled.add(j);
      k = end;
      continue;
    }
    const replacement = resolve(parts);
    if (!replacement) throw new SimulationStop(`it reads ${shown}, which isn't in the scan, so nothing can stand in for it`);
    const next = at(end + 1);
    const alias = isWord(next, "AS") ? end + 2 : isName(next) ? end + 1 : undefined;
    if (alias !== undefined) handled.add(alias);
    replaced.set(k, { span: end - k + 1, with: concat(["(", replacement, ")", alias !== undefined ? "" : ` AS ${quoteIdentifier(parts.at(-1)!)}`]) });
    for (let j = k; j <= end; j++) handled.add(j);
    k = end;
  }

  // Nothing real may be left: a known name that wasn't replaced is either a qualifier (A.COLUMN) or stops the run.
  for (let k = 0; k < sig.length; k++) {
    const t = at(k)!;
    if (handled.has(k) || !isName(t) || at(k - 1)?.text === ".") continue;
    const second = at(k + 1)?.text === "." && isName(at(k + 2)) ? at(k + 2)! : undefined;
    if (second) {
      if (isKnown([t.value, second.value])) throw new SimulationStop(`${t.value}.${second.value} appears where the simulation can't tell whether it's read`);
    } else if (isKnown([t.value])) {
      throw new SimulationStop(`${t.value} appears where the simulation can't tell whether it's read`);
    }
  }

  const out: (string | Fragment)[] = [];
  const bySig = new Map(sig.map((tokenIndex, k) => [tokenIndex, k]));
  for (let i = 0; i < tokens.length; i++) {
    const k = bySig.get(i);
    const r = k === undefined ? undefined : replaced.get(k);
    if (!r) {
      out.push(tokens[i].text);
      continue;
    }
    out.push(r.with);
    // Skip the name's tokens, and the spaces between them.
    i = sig[k! + r.span - 1];
  }
  return concat(out);
}
