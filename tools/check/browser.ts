/**
 * Opens the running web app in Chromium at several widths, as a signed-in
 * user, and records what a person would not see at a glance: console errors
 * and warnings, uncaught exceptions, Content-Security-Policy violations,
 * requests to any other site, failed API calls, pages wider than the
 * window, text a box cuts off, technical names broken mid-word in a column
 * too narrow for them, and lineage nodes the minimap covers when the picture opens. Every page and width gets a screenshot, and a page taller than the
 * window one more per screenful. It only opens pages: it clicks nothing and
 * changes nothing in the app.
 *
 *   npm run check:browser                                   # as the operator, or else the first admin
 *   npm run check:browser -- --as you@example.com --account "My company"
 *   npm run check:browser -- --page /users --page /operator --widths 390,1440 --dark
 *   npm run check:browser -- --tenant "Synthetic demo"      # only that tenant's pages
 *   npm run check:browser -- --url http://127.0.0.1:5173    # the Vite dev server instead of the API's port
 *
 * Without --page it opens every kind of page that has data: sign-in (signed
 * out), Tenants, each tenant's apps (Home, Discovery, Pipelines, Technical
 * client, Database users), its newest successful scan, its first saved
 * pipeline in both tabs with its newest snapshot and the comparison of its
 * latest two, Users and roles for admins and Operator for operators. --tenant
 * (once or more) keeps to those tenants. --page takes a path on this app that
 * starts with one "/", so it never opens another site. Without a tenant of your
 * own, `npm run db:demo` adds a synthetic one whose names are as long as
 * Datasphere allows.
 *
 * Signing in: the check writes a 15-minute session for the user straight into
 * the database and deletes it at the end, so it needs no password or
 * authenticator code. Anyone who can write to the database can do that anyway;
 * still, the check refuses an app or database that is not on this machine.
 *
 * Output: tools/check/output/browser-<time>/ (git-ignored, the screenshots
 * can show tenant object names) with one PNG per page and width (page@1440.png,
 * then page@1440-2.png and on for each screenful further down), and
 * report.json. The exit code is 1 when anything was found.
 *
 * First time on a machine: `npx playwright install chromium`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { connect, createSession, databaseUrl, deleteSession, findUserByEmail, listUserOverviews, membershipsOf } from "@ystara/db";
import type { PipelineDefinition, Scan, Snapshot, Tenant } from "@ystara/shared";
import { loadLocalEnv } from "@ystara/shared/env";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadLocalEnv(root);

const { values } = parseArgs({
  options: {
    as: { type: "string" },
    account: { type: "string" },
    url: { type: "string" },
    page: { type: "string", multiple: true },
    widths: { type: "string", default: "390,1024,1440,1920" },
    tenant: { type: "string", multiple: true },
    dark: { type: "boolean", default: false },
  },
});

const base = new URL(values.url ?? `http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}`).origin;
const widths = values.widths.split(",").map((w) => Number(w.trim()));

/** Stops the check with a message for the user; the session is still cleaned up. */
class Stop extends Error {}

/** One thing worth a look on one page at one width. */
interface Problem {
  kind: "console" | "exception" | "csp" | "outside-request" | "http" | "request-failed" | "overflow" | "clipped" | "broken-name" | "covered";
  detail: string;
}
interface PageResult {
  label: string;
  path: string;
  width: number;
  signedIn: boolean;
  screenshot: string;
  /** The screenfuls further down a page taller than the window, in order. */
  more: string[];
  problems: Problem[];
  /** Expected answers, such as the 401 a signed-out page gets for "who am I". */
  notes: string[];
}
interface PageToOpen {
  label: string;
  path: string;
  signedIn: boolean;
}

const db = connect();
let token: string | undefined;
let browser: Browser | undefined;
try {
  await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (token) await deleteSession(db, token);
  await db.close();
}

async function main() {
  if (widths.some((w) => !Number.isInteger(w) || w < 320 || w > 3840)) fail("--widths takes numbers between 320 and 3840, e.g. 390,1440");
  // A page is a path on this app, so the check never opens another site ("@other.site" or "//other.site" would).
  for (const p of values.page ?? []) {
    if (!p.startsWith("/") || p.startsWith("//") || new URL(base + p).origin !== base) fail(`--page takes a path on this app that starts with one "/", e.g. /users (not ${p}).`);
  }
  // The check signs in without a code, so it only runs against this machine.
  const local = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (!local.has(new URL(base).hostname)) fail(`${base} is not on this machine. The browser check only runs against a local app.`);
  if (!local.has(new URL(databaseUrl()).hostname)) fail("The database is not on this machine. The browser check only runs against a local database.");

  const who = await chooseUser();
  token = await createSession(db, { userId: who.userId, accountId: who.accountId, verified: true, minutes: 15 });
  const cookie = `ystara_session=${token}`;

  const pages = values.page?.length ? values.page.map((p) => ({ label: slug(p), path: p, signedIn: !p.startsWith("/sign-in") })) : await discoverPages(cookie, who);

  try {
    browser = await chromium.launch();
  } catch (e) {
    fail(`Chromium did not start (${firstLine(e)}). On a new machine, run \`npx playwright install chromium\` once.`);
  }

  const run = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const outDir = path.join(root, "tools", "check", "output", `browser-${run}`);
  await mkdir(outDir, { recursive: true });

  console.log(`Checking ${base} as ${who.email} in ${who.accountName} (${who.role}${who.operator ? ", operator" : ""}), ${values.dark ? "dark" : "light"} mode`);
  const results: PageResult[] = [];
  for (const width of widths) {
    for (const signedIn of [false, true]) {
      const group = pages.filter((p) => p.signedIn === signedIn);
      if (!group.length) continue;
      const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: values.dark ? "dark" : "light" });
      if (signedIn) await context.addCookies([{ name: "ystara_session", value: token, url: `${base}/api` }]);
      for (const page of group) results.push(await check(context, page, width, outDir));
      await context.close();
    }
  }

  const total = results.reduce((n, r) => n + r.problems.length, 0);
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ base, user: who.email, account: who.accountName, widths, dark: values.dark, problems: total, pages: results }, null, 2),
  );

  for (const r of results) {
    const head = `${r.problems.length ? `${r.problems.length} problem(s)`.padEnd(12) : "ok".padEnd(12)} ${r.label} @${r.width}`;
    console.log(head);
    for (const p of r.problems.slice(0, 5)) console.log(`             - [${p.kind}] ${p.detail}`);
    if (r.problems.length > 5) console.log(`             - ... ${r.problems.length - 5} more in report.json`);
  }
  console.log(`\n${results.length} page views, ${total} problem(s). Screenshots and report.json: ${path.relative(root, outDir)}`);
  if (total) process.exitCode = 1;
}

async function check(context: BrowserContext, target: PageToOpen, width: number, outDir: string): Promise<PageResult> {
  const page = await context.newPage();
  const problems: Problem[] = [];
  const notes: string[] = [];
  page.on("console", (m) => {
    // Failed loads are reported with their URL and status by the response handler below.
    if ((m.type() === "error" || m.type() === "warning") && !m.text().startsWith("Failed to load resource")) problems.push({ kind: "console", detail: `${m.type()}: ${clip(m.text())}` });
  });
  page.on("pageerror", (e) => problems.push({ kind: "exception", detail: clip(e.message) }));
  page.on("request", (r) => {
    const url = new URL(r.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== base) problems.push({ kind: "outside-request", detail: `${r.method()} ${clip(r.url())}` });
  });
  page.on("requestfailed", (r) => problems.push({ kind: "request-failed", detail: `${r.method()} ${clip(r.url())}: ${r.failure()?.errorText}` }));
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const what = `${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`;
    if (!target.signedIn && r.status() === 401) notes.push(`${what} (signed out, expected)`);
    else problems.push({ kind: "http", detail: what });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __cspViolations?: string[] };
      (w.__cspViolations ??= []).push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });

  await page.goto(base + target.path, { waitUntil: "load" });
  // Pages that refresh while a scan runs never go quiet, so don't wait for that forever.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => notes.push("still loading after 5 s"));
  await page.waitForTimeout(500);

  for (const v of await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])) problems.push({ kind: "csp", detail: v });
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  if (overflow > 1) problems.push({ kind: "overflow", detail: `the page is ${overflow}px wider than the window (sideways scrolling)` });
  // Text that sticks out of a box which hides its overflow (a card, say): it is cut off, and since the page itself
  // doesn't get wider, the check above can't see it. The walk goes up through slots and shadow roots, because UI5
  // components clip inside their own shadow DOM. Boxes that scroll, and the lineage picture, are left alone.
  const clipped = await page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.querySelectorAll(".app-main *")) {
      const text = el.textContent?.trim() ?? "";
      if (el.children.length > 0 || !text || el.closest(".react-flow")) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      let up: Element | null = el.assignedSlot ?? el.parentElement ?? (el.parentNode as ShadowRoot | null)?.host ?? null;
      while (up && !up.classList.contains("app-main")) {
        const overflow = getComputedStyle(up).overflowX;
        if (overflow === "auto" || overflow === "scroll") break;
        const frame = up.getBoundingClientRect();
        if ((overflow === "hidden" || overflow === "clip") && (box.right > frame.right + 1 || box.left < frame.left - 1)) {
          found.push(text.slice(0, 60));
          break;
        }
        up = up.assignedSlot ?? up.parentElement ?? (up.parentNode as ShadowRoot | null)?.host ?? null;
      }
    }
    return [...new Set(found)];
  });
  for (const text of clipped) problems.push({ kind: "clipped", detail: `"${text}" runs out of its box and is cut off` });
  // A technical name has no spaces, so in a table it can only wrap mid-word. That is a problem when it would fit on
  // one line in most of the table's width: its column is too narrow, and could move the other columns under the row.
  const broken = await page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".app-main ui5-table-cell .mono, .app-main ui5-table-cell.mono")) {
      const text = el.textContent?.trim() ?? "";
      if (el.children.length > 0 || !text || /\s/.test(text)) continue;
      const room = (el.closest("ui5-table")?.clientWidth ?? 0) * 0.8;
      const range = document.createRange();
      range.selectNodeContents(el);
      if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size < 2) continue;
      const style = el.style.cssText;
      el.style.whiteSpace = "nowrap";
      el.style.overflowWrap = "normal";
      const natural = range.getBoundingClientRect().width;
      el.style.cssText = style;
      if (natural < room) found.push(text.slice(0, 60));
    }
    return [...new Set(found)];
  });
  for (const name of broken) problems.push({ kind: "broken-name", detail: `${name} breaks mid-word in a table column, though one line of the table would hold it` });
  // The lineage picture opens clear of its minimap (openingViewport in the web app): a node under it is a layout bug.
  const covered = await page.evaluate(() => {
    const minimap = document.querySelector(".react-flow__minimap")?.getBoundingClientRect();
    if (!minimap) return [];
    return [...document.querySelectorAll(".react-flow__node")]
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.left < minimap.right && r.right > minimap.left && r.top < minimap.bottom && r.bottom > minimap.top;
      })
      .map((n) => n.querySelector(".lineage-node-name")?.textContent ?? "a node");
  });
  for (const name of covered) problems.push({ kind: "covered", detail: `the lineage minimap covers ${name} when the picture opens` });

  const screenshot = path.join(outDir, `${target.label}@${width}${values.dark ? "-dark" : ""}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const more = await screenfuls(page, screenshot);
  await page.close();
  return {
    label: target.label,
    path: target.path,
    width,
    signedIn: target.signedIn,
    screenshot: path.relative(root, screenshot),
    more: more.map((file) => path.relative(root, file)),
    problems,
    notes,
  };
}

/**
 * Pages scroll inside the app's main area rather than the window, so a
 * full-page screenshot shows only the first screenful. Scroll it down a
 * screen at a time (a little overlap, at most 5 more) and take each.
 */
async function screenfuls(page: Page, first: string): Promise<string[]> {
  const files: string[] = [];
  for (let n = 2; n <= 6; n++) {
    const scrolled = await page.evaluate(() => {
      const main = document.querySelector(".app-main");
      if (!main || main.scrollTop + main.clientHeight >= main.scrollHeight - 1) return false;
      main.scrollTop += main.clientHeight - 60;
      return true;
    });
    if (!scrolled) break;
    await page.waitForTimeout(200);
    const file = first.replace(/\.png$/, `-${n}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  return files;
}

/** --as and --account, or else the operator (or the first admin) in their first account. */
async function chooseUser() {
  let email = values.as?.trim().toLowerCase();
  if (!email) {
    const users = await listUserOverviews(db);
    const pick = users.find((u) => u.operator) ?? users.find((u) => u.accounts.some((a) => a.role === "admin"));
    if (!pick) fail("There is no user yet. Create one first: npm run account:create -- --name <Account> --admin <email>");
    email = pick.email;
  }
  const user = await findUserByEmail(db, email);
  if (!user) fail(`There is no user ${email}.`);
  const accounts = await membershipsOf(db, user.id);
  const account = values.account ? accounts.find((a) => a.name.toLowerCase() === values.account!.trim().toLowerCase()) : accounts[0];
  if (!account) fail(values.account ? `${email} is not a member of ${values.account}. Their accounts: ${accounts.map((a) => a.name).join(", ") || "none"}` : `${email} is not a member of any account.`);
  const operator = (await listUserOverviews(db)).find((u) => u.id === user.id)?.operator ?? false;
  return { userId: user.id, email, accountId: account.id, accountName: account.name, role: account.role, operator };
}

/** Every kind of page that has something to show for this user. */
async function discoverPages(cookie: string, who: { role: string; operator: boolean }): Promise<PageToOpen[]> {
  const get = async <T>(apiPath: string): Promise<T> => {
    const res = await fetch(`${base}/api${apiPath}`, { headers: { cookie } });
    if (!res.ok) fail(`GET /api${apiPath} answered ${res.status}. Is the app running at ${base}?`);
    return (await res.json()) as T;
  };
  const pages: PageToOpen[] = [
    { label: "sign-in", path: "/sign-in", signedIn: false },
    { label: "tenants", path: "/tenants", signedIn: true },
  ];
  const all = await get<Tenant[]>("/tenants");
  const picked = values.tenant ? all.filter((t) => values.tenant!.some((name) => name.trim().toLowerCase() === t.name.toLowerCase())) : all;
  if (values.tenant && picked.length < values.tenant.length) fail(`--tenant names a tenant the account doesn't have. Its tenants: ${all.map((t) => t.name).join(", ") || "none"}`);
  for (const tenant of picked) {
    // With several tenants, each page's label (and screenshot) starts with its tenant's name.
    const label = (page: string) => (picked.length > 1 ? `${slug(tenant.name)}-${page}` : page);
    const add = (page: string, p: string) => pages.push({ label: label(page), path: p, signedIn: true });
    add("home", `/tenants/${tenant.id}`);
    add("discovery", `/tenants/${tenant.id}/discovery`);
    add("pipelines", `/tenants/${tenant.id}/pipelines`);
    add("technical-client", `/tenants/${tenant.id}/connection`);
    add("database-users", `/tenants/${tenant.id}/database-users`);
    const scan = (await get<Scan[]>(`/tenants/${tenant.id}/scans`)).find((s) => s.status === "succeeded");
    if (scan) add("scan", `/scans/${scan.id}`);
    const [pipeline] = await get<PipelineDefinition[]>(`/tenants/${tenant.id}/pipelines`);
    if (pipeline) {
      add("pipeline", `/pipelines/${pipeline.id}`);
      add("pipeline-snapshots", `/pipelines/${pipeline.id}/snapshots`);
      const snapshots = await get<Snapshot[]>(`/pipelines/${pipeline.id}/snapshots`);
      if (snapshots[0]) add("snapshot", `/snapshots/${snapshots[0].id}`);
      if (snapshots.filter((s) => s.status === "succeeded").length >= 2) add("compare", `/pipelines/${pipeline.id}/compare`);
    }
  }
  if (who.role === "admin") pages.push({ label: "users", path: "/users", signedIn: true });
  if (who.operator) pages.push({ label: "operator", path: "/operator", signedIn: true });
  return pages;
}

function slug(p: string) {
  return p.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 60) || "home";
}

function clip(text: string) {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function firstLine(e: unknown) {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0];
}

function fail(message: string): never {
  throw new Stop(message);
}
