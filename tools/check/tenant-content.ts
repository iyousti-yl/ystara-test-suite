/**
 * Looks for tenant-specific content in what is about to leave this machine:
 * object and space names, tenant hosts, customer names and real email
 * addresses (CLAUDE.md: nothing tenant-specific in the repository, ever).
 *
 *   npm run check:tenant-content                              # this branch against origin/main, plus uncommitted and untracked files
 *   npm run check:tenant-content -- --base phase-1d-sign-in   # a branch stacked on another one
 *   npm run check:tenant-content -- --file pr-body.md         # also a text that leaves another way (a PR description)
 *   npm run check:tenant-content -- --base <sha> --head <sha> # only the commits a push sends (the pre-push hook and CI)
 *
 * What it looks for comes from the git-ignored places that hold tenant
 * content on this machine, and is never printed as a list:
 *   - saved scans: space, technical and business names in tools/scan/output/<run>/graph.json
 *   - tools/scan/scan.local.json: writer exclusions
 *   - *.local.md notes (e.g. .claude/tenant-conventions.local.md): names in `backticks` and NAMES_LIKE_THIS;
 *     a name ending in _ or * is a prefix (a naming convention)
 *   - the local database, when it runs: scanned objects, tenant names and hosts, account names, user emails
 * plus, always, Datasphere/HANA Cloud host names and email addresses outside the example domains.
 * Names are found as whole words and ignoring case (SALES_ORDERS_SYNTH also finds
 * sales_orders_synth). Names of 3 characters are looked for only with a digit or
 * an underscore (A1B, ZX_); plain words of 1 to 3 letters (HR, API) are too generic.
 *
 * Where it looks: lines added on this branch since --base, uncommitted and
 * untracked files, file names, commit messages with their authors and
 * committers, and every --file. With --head, only the commits up to that one
 * (what a push sends): uncommitted and untracked files stay on this machine.
 * Images that are added are listed to check by eye, and files that must never
 * be committed (.env*, *.local.*, scan and check output) are refused outright;
 * --file refuses to read them too.
 *
 * A hit is listed apart as "already in --base" when the exact same text (same
 * case, whole word) is in a file there, package-lock.json aside, or, for an
 * author or committer, when the same name and address made a commit there. It
 * is not new, but it may be a leak from before or simply a generic word. The
 * exit code is 1 when there is a new hit or a file that must never be committed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect, databaseUrl } from "@ystara/db";
import { loadLocalEnv } from "@ystara/shared/env";
import { addedLines, buildMatcher, DRAFTS_FOLDER, EXAMPLE_DOMAIN, findIn, longEnough, mustNeverCommit, refusedFile, type Hit, type Line, type Term } from "./tenant-rules.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" }, file: { type: "string", multiple: true } } });

// The check prints the lines that match, so --file could otherwise show .env.local,
// tenant notes or any file on the machine. The path decides, before anything is
// read; a link is judged by where it points too.
for (const file of values.file ?? []) {
  const full = path.resolve(file);
  if (refusedFile(file, process.cwd(), root) || (existsSync(full) && refusedFile(realpathSync(full), realpathSync(root), realpathSync(root)))) {
    stop(
      `--file ${file}: refused. Only files inside the repository are read: put the text in ${DRAFTS_FOLDER} (git ignores it). ` +
        "Files that must never be committed (.env*, .master-key, *.local.*, scan and check output) and .git are not read either.",
    );
  }
}

loadLocalEnv(root);

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf)$/i;

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const base = values.base ?? (tryGit("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "main");
// --verify also refuses anything that looks like an option (--output=...), so --base and --head can't pass one on to git.
if (!tryGit("rev-parse", "--verify", "-q", base)) stop(`There is no branch or commit ${base}. Pass --base <branch>.`);
// With --head, only what a push sends: the commits from --base up to --head.
const head = values.head ?? "HEAD";
const pushOnly = values.head !== undefined;
if (!tryGit("rev-parse", "--verify", "-q", `${head}^{commit}`)) stop(`There is no commit ${head}.`);

const dbNotes: string[] = [];
const terms = await localTerms();
const matcher = buildMatcher(terms);
const { lines, paths, images, counts } = outgoing();

const hits: Hit[] = [];
for (const line of lines) hits.push(...findIn(line, matcher));
const neverCommit = paths.filter(mustNeverCommit);

// Split hits into new ones and ones already in the base branch: the exact same
// text (same case, as a whole word) in one of its files, or, for an author or
// committer, the same name and address on one of its commits. The lockfile
// doesn't count: its thousands of package names would let short real names pass.
const baseIdentities = new Set(git("log", "--format=%an <%ae>%n%cn <%ce>", base).split("\n"));
const known = new Map<string, boolean>();
const inBase = (h: Hit) => {
  if (h.identity && baseIdentities.has(h.text)) return true;
  if (!known.has(h.match)) known.set(h.match, tryGit("grep", "-q", "-w", "-F", "-e", h.match, base, "--", ":(exclude)package-lock.json"));
  return known.get(h.match)!;
};
const fresh = hits.filter((h) => !inBase(h));
const old = hits.filter((h) => inBase(h));

const bySource = new Map<string, number>();
for (const t of terms) bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1);
console.log(`Looked for ${terms.length} tenant names (${[...bySource].map(([s, n]) => `${n} from ${s}`).join(", ") || "no local tenant content found"}), plus Datasphere hosts and email addresses.`);
for (const note of dbNotes) console.log(note);
const workingTree = pushOnly ? ` up to ${head}` : `, ${counts.uncommitted} uncommitted, ${counts.untracked} in untracked files`;
console.log(`Checked: ${counts.branch} lines added since ${base}${workingTree}, ${counts.messages} lines of commit messages, authors and committers, ${counts.extra} in extra files, ${paths.length} file names.\n`);

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
    if (!longEnough(t, k)) return;
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
    for (const v of [...got.spaces, ...got.names, ...got.businessNames]) if (v && longEnough(v, "word")) terms.push({ text: v, source: "local database", kind: "word" });
    for (const v of [...got.tenants, ...got.accounts]) if (v && longEnough(v, "word") && !/synthetic/i.test(v)) terms.push({ text: v, source: "local database", kind: "word" });
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

/** Everything that leaves with the push: added lines, uncommitted and untracked files, file names, commits, extra files. */
function outgoing() {
  const lines: Line[] = [];
  const counts = { branch: 0, uncommitted: 0, untracked: 0, messages: 0, extra: 0 };
  const added = (diff: string, key: "branch" | "uncommitted") => {
    for (const a of addedLines(diff)) {
      lines.push({ where: `${a.file}:${a.lineNo}`, text: a.text });
      counts[key]++;
    }
  };
  added(git("diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...${head}`), "branch");
  // A push sends commits only: uncommitted and untracked files stay on this machine.
  if (!pushOnly) added(git("diff", "--unified=0", "--no-color", "--no-ext-diff", "HEAD"), "uncommitted");

  const untracked = pushOnly ? [] : git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  for (const file of untracked) {
    const full = path.join(root, file);
    if (IMAGE.test(file) || statSync(full).size > 2_000_000) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((t, i) => lines.push({ where: `${file}:${i + 1}`, text: t }));
    counts.untracked += text.split("\n").length;
  }

  // Each commit's message, and who wrote and committed it: names and addresses leave with the push too.
  for (const commit of git("log", "--format=%x00%h%n%an <%ae>%n%cn <%ce>%n%B", `${base}..${head}`).split("\0").slice(1)) {
    const [hash, author, committer, ...message] = commit.split("\n");
    lines.push({ where: `commit ${hash} author`, text: author, identity: true }, { where: `commit ${hash} committer`, text: committer, identity: true });
    counts.messages += 2;
    message.forEach((t, i) => {
      if (!t.trim()) return;
      lines.push({ where: `commit ${hash} message, line ${i + 1}`, text: t });
      counts.messages++;
    });
  }
  // Refused names were stopped at the start.
  for (const file of values.file ?? []) {
    const text = readFileSync(path.resolve(file), "utf8");
    text.split("\n").forEach((t, i) => lines.push({ where: `${file}:${i + 1}`, text: t }));
    counts.extra += text.split("\n").length;
  }

  const changed = new Set([
    ...git("diff", "--name-only", "--no-renames", `${base}...${head}`).split("\n"),
    ...(pushOnly ? [] : git("diff", "--name-only", "--no-renames", "HEAD").split("\n")),
    ...untracked,
  ]);
  changed.delete("");
  const paths = [...changed];
  for (const p of paths) lines.push({ where: `file name ${p}`, text: p });
  // Images still there (not deleted): in the pushed commit with --head, else on disk.
  const images = paths.filter((p) => IMAGE.test(p) && (pushOnly ? tryGit("cat-file", "-e", `${head}:${p}`) : existsSync(path.join(root, p))));
  return { lines, paths, images, counts };
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
