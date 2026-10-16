/**
 * Looks for tenant-specific content in what is about to leave this machine:
 * object and space names, tenant hosts, customer names and real email
 * addresses (CLAUDE.md: nothing tenant-specific in the repository, ever).
 *
 *   npm run check:tenant-content                              # this branch against origin/main, plus uncommitted and untracked files
 *   npm run check:tenant-content -- --base phase-1d-sign-in   # a branch stacked on another one
 *   npm run check:tenant-content -- --file pr-body.md         # also a text that leaves another way (a PR description)
 *
 * What it looks for comes from the git-ignored places that hold tenant
 * content on this machine, and is never printed as a list:
 *   - saved scans: space, technical and business names in tools/scan/output/<run>/graph.json
 *   - tools/scan/scan.local.json: writer exclusions
 *   - *.local.md notes (e.g. .claude/tenant-conventions.local.md): names in `backticks` and NAMES_LIKE_THIS;
 *     a name ending in _ or * is a prefix (a naming convention)
 *   - the local database, when it runs: scanned objects, tenant names and hosts, account names, user emails
 * plus, always, Datasphere/HANA Cloud host names and email addresses outside the example domains.
 *
 * Where it looks: lines added on this branch since --base, uncommitted and
 * untracked files, file names, commit messages, and every --file. Images that
 * are added are listed to check by eye, and files that must never be
 * committed (.env*, *.local.*, scan and check output) are refused outright.
 *
 * A hit whose text is already in --base is listed apart: it is not new, but
 * it may be a leak from before or simply a generic word. The exit code is 1
 * when there is a new hit or a file that must never be committed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect, databaseUrl } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const { values } = parseArgs({ options: { base: { type: "string" }, file: { type: "string", multiple: true } } });

/** Something tenant-specific to look for. */
interface Term {
  text: string;
  source: string;
  /** word: the whole name; prefix: the start of a name (a naming convention); text: anywhere, ignoring case (hosts, emails). */
  kind: "word" | "prefix" | "text";
}
/** A place in what leaves the machine, and the line there. */
interface Line {
  where: string;
  text: string;
}
interface Hit extends Line {
  match: string;
  source: string;
}

const MIN_LENGTH = 4;
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost|local)$/i;
/** Addresses that are fine anywhere: commit attribution and GitHub's no-reply addresses. */
const OWN_ADDRESS = /^(noreply@anthropic\.com|.*@users\.noreply\.github\.com)$/i;
const NEVER_COMMIT = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.local\.(md|json)$/, /^tools\/(scan|spike|check)\/output\//];
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf)$/i;
const GENERIC = [
  { source: "Datasphere host", pattern: /\b[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(hcs\.cloud\.sap|hanacloud\.ondemand\.com|hana\.ondemand\.com)\b/gi },
  { source: "email address", pattern: /\b[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}\b/g },
];

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const base = values.base ?? (tryGit("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "main");
if (!tryGit("rev-parse", "--verify", "-q", base)) stop(`There is no branch or commit ${base}. Pass --base <branch>.`);

const dbNotes: string[] = [];
const terms = await localTerms();
const matcher = buildMatcher(terms);
const { lines, paths, images, counts } = outgoing();

const hits: Hit[] = [];
for (const line of lines) hits.push(...findIn(line));
const neverCommit = paths.filter((p) => NEVER_COMMIT.some((r) => r.test(p)));

// Split hits into new ones and ones whose text is already in the base branch.
const known = new Map<string, boolean>();
const inBase = (h: Hit) => {
  const key = h.match.toLowerCase();
  if (!known.has(key)) known.set(key, tryGit("grep", "-q", "-i", "-F", h.match, base, "--"));
  return known.get(key)!;
};
const fresh = hits.filter((h) => !inBase(h));
const old = hits.filter((h) => inBase(h));

const bySource = new Map<string, number>();
for (const t of terms) bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1);
console.log(`Looked for ${terms.length} tenant names (${[...bySource].map(([s, n]) => `${n} from ${s}`).join(", ") || "no local tenant content found"}), plus Datasphere hosts and email addresses.`);
for (const note of dbNotes) console.log(note);
console.log(`Checked: ${counts.branch} lines added since ${base}, ${counts.uncommitted} uncommitted, ${counts.untracked} in untracked files, ${counts.messages} commit message lines, ${counts.extra} in extra files, ${paths.length} file names.\n`);

print(`New hits (block the push): ${fresh.length}`, fresh);
print(`Already in ${base} (not new; a generic word, or a leak from before): ${old.length}`, old);
if (images.length) console.log(`Images added, check them by eye: ${images.join(", ")}\n`);
if (neverCommit.length) console.log(`Files that must never be committed: ${neverCommit.join(", ")}\n`);
const blocked = fresh.length > 0 || neverCommit.length > 0;
console.log(blocked ? "Verdict: BLOCKED" : "Verdict: CLEAN");
if (blocked) process.exitCode = 1;

// ---

function print(title: string, list: Hit[]) {
  console.log(title);
  for (const h of list.slice(0, 50)) console.log(`  ${h.where}  "${h.match}" [${h.source}]  ${clip(h.text.trim())}`);
  if (list.length > 50) console.log(`  ... ${list.length - 50} more`);
  console.log("");
}

/** Every name this machine knows from a tenant. */
async function localTerms(): Promise<Term[]> {
  const found: Term[] = [];
  const add = (text: unknown, source: string, kind?: Term["kind"]) => {
    if (typeof text !== "string") return;
    let t = text.trim();
    let k = kind ?? "word";
    if (/[_*]$/.test(t) && !kind) {
      t = t.replace(/\*+$/, "");
      k = "prefix";
    }
    if (t.length < MIN_LENGTH && !(k === "prefix" && t.length >= 3)) return;
    found.push({ text: t, source, kind: k });
  };

  // Saved scans.
  const scanOut = path.join(root, "tools", "scan", "output");
  for (const run of existsSync(scanOut) ? readdirSync(scanOut) : []) {
    const graphFile = path.join(scanOut, run, "graph.json");
    if (!existsSync(graphFile)) continue;
    const graph = JSON.parse(readFileSync(graphFile, "utf8")) as { nodes?: { space?: string; technicalName?: string; businessName?: string }[] };
    for (const n of graph.nodes ?? []) {
      add(n.space, "saved scans");
      add(n.technicalName?.replace(/[_*]+$/, ""), "saved scans");
      if (n.businessName && /[\s_\d]/.test(n.businessName)) add(n.businessName, "saved scans", "word");
    }
  }

  // Writer exclusions.
  const settings = path.join(root, "tools", "scan", "scan.local.json");
  if (existsSync(settings)) {
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    for (const s of strings(JSON.parse(readFileSync(settings, "utf8")))) for (const part of s.split(".")) add(part.replace(/\?/g, ""), "scan.local.json");
  }

  // Local notes: `names` and NAMES_LIKE_THIS.
  for (const file of localNotes(root)) {
    const text = readFileSync(file, "utf8");
    // Lower-case words in backticks are commands and file names; tenant names have capitals, digits or underscores.
    for (const [, name] of text.matchAll(/`([A-Za-z0-9][A-Za-z0-9_.*-]*)`/g)) {
      if (!/[A-Z0-9_]/.test(name) || (name.includes(".") && !/^[A-Z0-9_]+\.[A-Z0-9_*]+$/.test(name))) continue;
      for (const part of name.split(".")) add(part, path.basename(file));
    }
    for (const [name] of text.matchAll(/\b[A-Z0-9]+_[A-Z0-9_]*\*?/g)) add(name, path.basename(file));
  }

  // The local database, when it runs.
  for (const t of await databaseTerms()) found.push(t);

  // One entry per text and kind.
  const seen = new Set<string>();
  return found.filter((t) => {
    const key = `${t.kind}:${t.text}`;
    return !seen.has(key) && seen.add(key);
  });
}

async function databaseTerms(): Promise<Term[]> {
  const host = new URL(databaseUrl()).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    dbNotes.push("Database: not on this machine, skipped.");
    return [];
  }
  const db = connect();
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000).unref());
  try {
    const read = async () => {
      const q = async (sql: string) => (await db.query<{ v: string | null }>(sql)).rows.map((r) => r.v);
      return {
        spaces: await q("select distinct space as v from scan_objects"),
        names: await q("select distinct technical_name as v from scan_objects"),
        businessNames: await q("select distinct business_name as v from scan_objects where business_name ~ '[[:space:]_0-9]'"),
        tenants: await q("select distinct name as v from tenants"),
        hosts: await q("select distinct host as v from tenants where host is not null"),
        accounts: await q("select name as v from accounts where name <> 'Default'"),
        emails: await q("select email as v from users"),
      };
    };
    const got = await Promise.race([read(), timeout]);
    if (got === "timeout") {
      dbNotes.push("Database: no answer within 3 s, skipped.");
      return [];
    }
    const terms: Term[] = [];
    for (const v of [...got.spaces, ...got.names, ...got.businessNames]) if (v && v.length >= MIN_LENGTH) terms.push({ text: v, source: "local database", kind: "word" });
    for (const v of [...got.tenants, ...got.accounts]) if (v && v.length >= MIN_LENGTH && !/synthetic/i.test(v)) terms.push({ text: v, source: "local database", kind: "word" });
    for (const v of got.hosts) if (v) terms.push({ text: new URL(v.includes("://") ? v : `https://${v}`).hostname, source: "local database", kind: "text" });
    for (const v of got.emails) if (v && !EXAMPLE_DOMAIN.test(v.split("@")[1] ?? "")) terms.push({ text: v, source: "local database", kind: "text" });
    return terms;
  } catch (e) {
    dbNotes.push(`Database: not reachable (${(e instanceof Error ? e.message : String(e)).split("\n")[0]}), skipped.`);
    return [];
  } finally {
    void db.close().catch(() => undefined);
  }
}

/** *.local.md files anywhere in the repository except dependencies and build output. */
function localNotes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...localNotes(full));
    else if (entry.name.endsWith(".local.md")) out.push(full);
  }
  return out;
}

/** Everything that leaves with the push: added lines, uncommitted and untracked files, file names, commit messages, extra files. */
function outgoing() {
  const lines: Line[] = [];
  const counts = { branch: 0, uncommitted: 0, untracked: 0, messages: 0, extra: 0 };
  const added = (diff: string, key: "branch" | "uncommitted") => {
    let file = "";
    let lineNo = 0;
    for (const l of diff.split("\n")) {
      if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
      else if (l.startsWith("@@")) lineNo = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
      else if (l.startsWith("+")) {
        lines.push({ where: `${file}:${lineNo}`, text: l.slice(1) });
        counts[key]++;
        lineNo++;
      }
    }
  };
  added(git("diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...HEAD`), "branch");
  added(git("diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD"), "uncommitted");

  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  for (const file of untracked) {
    const full = path.join(root, file);
    if (IMAGE.test(file) || statSync(full).size > 2_000_000) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((t, i) => lines.push({ where: `${file}:${i + 1}`, text: t }));
    counts.untracked += text.split("\n").length;
  }

  for (const [i, t] of git("log", "--format=%h %B", `${base}..HEAD`).split("\n").entries()) {
    if (!t.trim()) continue;
    lines.push({ where: `commit message, line ${i + 1}`, text: t });
    counts.messages++;
  }
  for (const file of values.file ?? []) {
    const text = readFileSync(path.resolve(file), "utf8");
    text.split("\n").forEach((t, i) => lines.push({ where: `${file}:${i + 1}`, text: t }));
    counts.extra += text.split("\n").length;
  }

  const changed = new Set([
    ...git("diff", "--name-only", "--no-renames", `${base}...HEAD`).split("\n"),
    ...git("diff", "--name-only", "--no-renames", "HEAD").split("\n"),
    ...untracked,
  ]);
  changed.delete("");
  const paths = [...changed];
  for (const p of paths) lines.push({ where: `file name ${p}`, text: p });
  const images = paths.filter((p) => IMAGE.test(p) && existsSync(path.join(root, p)));
  return { lines, paths, images, counts };
}

/** Tenant names in one line. */
function findIn(line: Line): Hit[] {
  const out: Hit[] = [];
  for (const m of line.text.matchAll(matcher.words)) out.push({ ...line, match: m[0], source: matcher.sourceOf(m[0]) });
  for (const m of line.text.matchAll(matcher.prefixes)) out.push({ ...line, match: m[0], source: matcher.sourceOf(m[1]) });
  for (const m of line.text.matchAll(matcher.texts)) out.push({ ...line, match: m[0], source: matcher.sourceOf(m[0].toLowerCase()) });
  for (const g of GENERIC) {
    for (const m of line.text.matchAll(g.pattern)) {
      if (g.source === "email address" && (EXAMPLE_DOMAIN.test(m[0].split("@")[1]) || OWN_ADDRESS.test(m[0]))) continue;
      if (g.source === "Datasphere host" && /^(example|your|my|tenant)[.-]/i.test(m[0])) continue;
      if (!out.some((h) => h.match.toLowerCase() === m[0].toLowerCase())) out.push({ ...line, match: m[0], source: g.source });
    }
  }
  return out;
}

function buildMatcher(list: Term[]) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternation = (kind: Term["kind"]) => {
    const texts = list.filter((t) => t.kind === kind).map((t) => t.text).sort((a, b) => b.length - a.length);
    // An empty list must match nothing.
    return texts.length ? texts.map(escape).join("|") : "(?!)";
  };
  const source = new Map<string, string>();
  for (const t of list) source.set(t.kind === "text" ? t.text.toLowerCase() : t.text, t.source);
  return {
    words: new RegExp(`(?<![A-Za-z0-9_])(?:${alternation("word")})(?![A-Za-z0-9_])`, "g"),
    prefixes: new RegExp(`(?<![A-Za-z0-9_])(${alternation("prefix")})[A-Za-z0-9_]*`, "g"),
    texts: new RegExp(alternation("text"), "gi"),
    sourceOf: (match: string) => source.get(match) ?? "local tenant content",
  };
}

function tryGit(...args: string[]) {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function clip(text: string) {
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}
