/**
 * The rules of the tenant-content check that need no git, files or database,
 * so they can be tested on their own (tenant-rules.test.ts). The check itself,
 * which finds the names and reads what is pushed, is tenant-content.ts.
 */
import path from "node:path";

/** Something tenant-specific to look for. */
export interface Term {
  text: string;
  source: string;
  /** word: the whole name; prefix: the start of a name (a naming convention); text: anywhere (hosts, emails). All ignore case. */
  kind: "word" | "prefix" | "text";
  /** An object name from a scan that is one plain word (User, POSITION): its hits are listed apart and don't block (see plainWord). */
  plain?: boolean;
}
/** A place in what leaves the machine, and the line there. */
export interface Line {
  where: string;
  text: string;
  /** A commit's author or committer ("Name <address>"). */
  identity?: boolean;
}
export interface Hit extends Line {
  match: string;
  source: string;
  /** The match is a plain word that is also an object name: listed, but doesn't block. */
  plain?: boolean;
}

/**
 * Where a text to check with `--file` goes, such as a PR description before it is posted: inside the repository
 * (`--file` reads nothing outside it) and git-ignored, so it is never committed.
 */
export const DRAFTS_FOLDER = "tools/check/drafts/";

/** Files that must never be committed: .env and .env.* (except .env.example), .master-key, *.local.md and *.local.json, scan and check output, --file drafts. */
export const NEVER_COMMIT = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /(^|\/)\.master-key$/,
  /\.local\.(md|json)$/,
  /^tools\/(scan|spike|check)\/output\//,
  /^tools\/check\/drafts\//,
];

/** `relativePath` is relative to the repository, with "/" between folders. */
export function mustNeverCommit(relativePath: string): boolean {
  return NEVER_COMMIT.some((r) => r.test(relativePath));
}

/**
 * True when `--file <file>` must not be read. The check prints the lines that
 * match, so it would otherwise be a way to show any file without a prompt.
 * Refused: anything outside the repository (a CLI token folder,
 * ~/.git-credentials), git's own folder (.git/config can hold a token), any
 * .env* or *.local.* file, and files that must never be committed (.master-key,
 * scan and check output), except the drafts folder made for --file. Decided on
 * the path alone, before anything is read. `cwd` is the folder `file` is
 * relative to, `root` the repository.
 */
export function refusedFile(file: string, cwd: string, root: string): boolean {
  // Resolved first, so ./.env.local, sub/../.env.local and an absolute path all look the same.
  const full = path.resolve(cwd, file);
  const fromRoot = path.relative(root, full);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return true;
  // Lower case: on Windows, .ENV.Local is the same file as .env.local.
  const relative = fromRoot.split(path.sep).join("/").toLowerCase();
  const name = path.basename(full).toLowerCase();
  if (relative === ".git" || relative.startsWith(".git/") || name.startsWith(".env") || name.includes(".local.")) return true;
  return mustNeverCommit(relative) && !relative.startsWith(DRAFTS_FOLDER);
}

/**
 * Long enough to look for. Names of 4 characters or more, and 3-character
 * names with a digit or underscore (A1B, ZX_): those are likely real
 * identifiers. Plain words of 1 to 3 letters (HR, API) are too generic and
 * would be found everywhere. A naming-convention prefix needs 3 characters.
 */
export function longEnough(text: string, kind: Term["kind"]): boolean {
  if (kind === "prefix") return text.length >= 3;
  return text.length >= 4 || (text.length === 3 && /[\d_]/.test(text));
}

/**
 * One plain word: letters only, in one case or capitalised (User, POSITION,
 * employee). Tenants have objects named like this, and code uses the same
 * words (`interface User`), so as object names from a scan they would block
 * pushes that have nothing to do with the tenant. Names with a digit, an
 * underscore or a capital inside (USER_V, Emp2, SalesOrder) are not plain.
 */
export function plainWord(text: string): boolean {
  return /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/.test(text);
}

/**
 * The names in a "Not tenant names" list of a local note, which the check
 * then doesn't look for (in any case). Two forms:
 *
 *   Not tenant names: `Position`, Employee       (on one line, and list items right below it)
 *
 *   ## Not tenant names                           (a heading: the list items up to the next heading)
 *   - `User`
 *   - Position, Employee
 *
 * In each comma-separated part, the names in backticks count, or the part
 * itself when it is a single name ("- `User`: an HR entity" gives User). Other text under the heading is still read as a note, so
 * a sentence there can't turn a tenant name off by accident.
 */
export function notTenantNames(markdown: string): string[] {
  const names: string[] = [];
  const take = (text: string) => {
    for (const part of text.split(",")) {
      const quoted = [...part.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
      for (const name of quoted.length ? quoted : [part.trim()]) if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\*?$/.test(name)) names.push(name.replace(/\*$/, ""));
    }
  };
  const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
  let section: "heading" | "line" | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const start = /^\s*(#+\s*)?not tenant names\b\s*:?\s*(.*)$/i.exec(line);
    if (start) {
      section = start[1] ? "heading" : "line";
      take(start[2]);
      continue;
    }
    if (/^\s*#/.test(line)) {
      section = undefined;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (section && item) take(item[1]);
    // On one line, the list ends at the first line that isn't an item; under a heading, at the next heading.
    else if (section === "line" && line.trim()) section = undefined;
  }
  return names;
}

/** Example domains and the local machine: an address there is not a real person's. */
export const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost|local)$/i;
/** Addresses that are fine anywhere: commit attribution and GitHub's no-reply addresses. */
const OWN_ADDRESS = /^(noreply@anthropic\.com|noreply@github\.com|.*@users\.noreply\.github\.com)$/i;
/** "page@1440.png" looks like an address but is a file name. */
const FILE_NAME = /\.(png|jpe?g|gif|webp|svg|pdf|json|md|ts|tsx|js|mjs|css|html|txt|log|csv)$/i;
const GENERIC = [
  { source: "Datasphere host", pattern: /\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(hcs\.cloud\.sap|hanacloud\.ondemand\.com|hana\.ondemand\.com)\b/gi },
  { source: "email address", pattern: /\b[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}\b/g },
];

/**
 * Hosts that are fine in docs and examples: the whole first part is a
 * placeholder (your-tenant.eu10.hcs.cloud.sap, not your-company.eu10...), or
 * SAP's shared sign-in host authentication.<region>.hana.ondemand.com with
 * nothing in front (with a name in front, it is a tenant's own sign-in host).
 */
export function placeholderHost(host: string): boolean {
  return /^(example|your-tenant|my-tenant|tenant|synthetic|synthetic-tenant)\./i.test(host) || /^authentication\.[a-z0-9-]+\.hana\.ondemand\.com$/i.test(host);
}

/** The added lines of a `git diff --unified=0`, with their file and line number. */
export function addedLines(diff: string): { file: string; lineNo: number; text: string }[] {
  const out: { file: string; lineNo: number; text: string }[] = [];
  let file = "";
  let lineNo = 0;
  // Between "diff --git" and the first "@@" come the file's headers ("--- a/x", "+++ b/x").
  // After "@@" every line is content, even one that reads "+++ x" (the added line "++ x").
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff ")) inHunk = false;
    else if (!inHunk && l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("@@")) {
      inHunk = true;
      lineNo = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    } else if (inHunk && l.startsWith("+")) {
      out.push({ file, lineNo, text: l.slice(1) });
      lineNo++;
    }
  }
  return out;
}

/**
 * One regular expression per kind of term, ignoring case. A name that is both a
 * plain object name and in a note or scan.local.json (in any case) is not plain:
 * there it blocks.
 */
export function buildMatcher(list: Term[]) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternation = (kind: Term["kind"]) => {
    const texts = list.filter((t) => t.kind === kind).map((t) => t.text).sort((a, b) => b.length - a.length);
    // An empty list must match nothing.
    return texts.length ? texts.map(escape).join("|") : "(?!)";
  };
  const info = new Map<string, { source: string; plain: boolean }>();
  for (const t of list) {
    const key = t.text.toLowerCase();
    const known = info.get(key);
    if (!known || (known.plain && !t.plain)) info.set(key, { source: t.source, plain: t.plain === true });
  }
  return {
    // A name counts only as a whole word: SALES_ORDERS is not found in SALES_ORDERS_V.
    words: new RegExp(`(?<![A-Za-z0-9_])(?:${alternation("word")})(?![A-Za-z0-9_])`, "gi"),
    prefixes: new RegExp(`(?<![A-Za-z0-9_])(${alternation("prefix")})[A-Za-z0-9_]*`, "gi"),
    texts: new RegExp(alternation("text"), "gi"),
    infoOf: (match: string) => info.get(match.toLowerCase()) ?? { source: "local tenant content", plain: false },
  };
}

/** Tenant names, Datasphere hosts and real email addresses in one line. */
export function findIn(line: Line, matcher: ReturnType<typeof buildMatcher>): Hit[] {
  const out: Hit[] = [];
  for (const m of line.text.matchAll(matcher.words)) {
    const { source, plain } = matcher.infoOf(m[0]);
    out.push({ ...line, match: m[0], source, ...(plain ? { plain } : {}) });
  }
  for (const m of line.text.matchAll(matcher.prefixes)) out.push({ ...line, match: m[0], source: matcher.infoOf(m[1]).source });
  for (const m of line.text.matchAll(matcher.texts)) out.push({ ...line, match: m[0], source: matcher.infoOf(m[0]).source });
  for (const g of GENERIC) {
    for (const m of line.text.matchAll(g.pattern)) {
      if (g.source === "email address" && (EXAMPLE_DOMAIN.test(m[0].split("@")[1]) || OWN_ADDRESS.test(m[0]) || FILE_NAME.test(m[0]))) continue;
      if (g.source === "Datasphere host" && placeholderHost(m[0])) continue;
      if (!out.some((h) => h.match.toLowerCase() === m[0].toLowerCase())) out.push({ ...line, match: m[0], source: g.source });
    }
  }
  return out;
}
