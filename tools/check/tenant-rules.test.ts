import path from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, buildMatcher, findIn, longEnough, notTenantNames, placeholderHost, plainWord, refusedFile, type Term } from "./tenant-rules.js";

// Hosts and addresses that the check must find are built from parts, so this
// file doesn't trip the check itself when it is pushed.
const host = (first: string) => [first, "eu10", "hcs.cloud.sap"].join(".");
const address = (domain: string) => ["jane.doe", domain].join("@");

describe("refusedFile", () => {
  const root = path.resolve("/repo");
  const refused = (file: string) => refusedFile(file, root, root);

  it("refuses .env files and local notes however the path is written", () => {
    for (const file of [".env", ".env.local", "./.env.local", "sub/../.env.local", path.join(root, ".env.local"), ".ENV.Local", ".env.example"]) {
      expect(refused(file), file).toBe(true);
    }
    expect(refused(".claude/tenant-conventions.local.md")).toBe(true);
    expect(refused("tools/scan/scan.local.json")).toBe(true);
    expect(refused("notes.local.txt")).toBe(true);
    expect(refused(".master-key")).toBe(true);
    expect(refused("./.Master-Key")).toBe(true);
  });

  it("refuses scan and check output, and git's own folder", () => {
    expect(refused("tools/scan/output/run-1/lineage.md")).toBe(true);
    expect(refused("tools/check/output/browser-1/report.json")).toBe(true);
    expect(refused(".git/config")).toBe(true);
    expect(refused(".GIT/config")).toBe(true);
    expect(refused(".git")).toBe(true);
  });

  it("refuses anything outside the repository, however the path is written", () => {
    for (const file of [path.resolve("/tmp/pr-body.md"), path.resolve("/tmp/ystara-tenant-1/ystara-client.json"), path.resolve("/home/me/.git-credentials"), "../other/notes.md", "sub/../../x.md", ".", ".."]) {
      expect(refused(file), file).toBe(true);
    }
    // A file name that only starts with two dots is inside.
    expect(refused("..notes.md")).toBe(false);
  });

  it("reads anything else in the repository, the drafts folder included", () => {
    expect(refused("pr-body.md")).toBe(false);
    expect(refused("docs/env-notes.md")).toBe(false);
    expect(refused("tools/check/drafts/pr-11.md")).toBe(false);
    expect(refused(path.join(root, "tools", "check", "drafts", "pr-11.md"))).toBe(false);
    expect(refused("tools/check/drafts/.env.local")).toBe(true);
  });
});

describe("placeholderHost", () => {
  it("lets placeholder hosts and SAP's bare sign-in host through", () => {
    expect(placeholderHost("your-tenant.eu10.hcs.cloud.sap")).toBe(true);
    expect(placeholderHost("synthetic.eu10.hcs.cloud.sap")).toBe(true);
    expect(placeholderHost("your-tenant.authentication.eu10.hana.ondemand.com")).toBe(true);
    expect(placeholderHost("authentication.eu10.hana.ondemand.com")).toBe(true);
  });

  it("finds hosts that merely start with a placeholder word", () => {
    for (const first of ["my-company", "your-company", "tenant-a", "example-corp", "synthetic2"]) expect(placeholderHost(host(first)), first).toBe(false);
    expect(placeholderHost(["acme", "authentication.eu10.hana.ondemand.com"].join("."))).toBe(false);
  });
});

describe("longEnough", () => {
  it("skips plain short words but not short identifiers", () => {
    expect(longEnough("HR", "word")).toBe(false);
    expect(longEnough("API", "word")).toBe(false);
    expect(longEnough("A1B", "word")).toBe(true);
    expect(longEnough("ZX_", "word")).toBe(true);
    expect(longEnough("ORDERS", "word")).toBe(true);
    expect(longEnough("ZX", "prefix")).toBe(false);
    expect(longEnough("ZXQ", "prefix")).toBe(true);
  });
});

describe("plainWord", () => {
  it("is one word of letters, in one case or capitalised", () => {
    for (const word of ["User", "POSITION", "employee"]) expect(plainWord(word), word).toBe(true);
  });

  it("is not a name with a digit, an underscore or a capital inside", () => {
    for (const name of ["USER_V", "Emp2", "SalesOrder", "eMPLOYEE", "SALES-ORDERS", "Employé"]) expect(plainWord(name), name).toBe(false);
  });
});

describe("notTenantNames", () => {
  it("reads a heading's list items up to the next heading", () => {
    const note = ["# Notes", "Prefixes: `ZX_`", "", "## Not tenant names", "These are generic:", "- `User`", "- Position, Employee", "* `Base`: in every tenant", "", "## Other", "- `ZX_ORDERS`"].join("\n");
    expect(notTenantNames(note)).toEqual(["User", "Position", "Employee", "Base"]);
  });

  it("reads one line and the list items right below it", () => {
    expect(notTenantNames("Not tenant names: `Position`, Employee\n- Unit\n\nPrefixes are `ZX_`.\n- `ZX_ORDERS`")).toEqual(["Position", "Employee", "Unit"]);
    expect(notTenantNames("not tenant names:\n\n1. `User*`")).toEqual(["User"]);
  });

  it("takes no words from sentences", () => {
    expect(notTenantNames("## Not tenant names\nAnything like `ZX_ORDERS` stays a tenant name.\n- user names, as in sign-in")).toEqual([]);
    expect(notTenantNames("Not tenant names are below.\nSee `ZX_ORDERS`.")).toEqual([]);
  });
});

describe("addedLines", () => {
  it("reads +++ as a file header only outside a hunk", () => {
    const diff = [
      "diff --git a/one.md b/one.md",
      "--- a/one.md",
      "+++ b/one.md",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+++ an added line that starts with ++",
      "diff --git a/two.md b/two.md",
      "--- /dev/null",
      "+++ b/two.md",
      "@@ -3,0 +4 @@",
      "+fourth",
    ].join("\n");
    expect(addedLines(diff)).toEqual([
      { file: "one.md", lineNo: 1, text: "first" },
      { file: "one.md", lineNo: 2, text: "++ an added line that starts with ++" },
      { file: "two.md", lineNo: 4, text: "fourth" },
    ]);
  });
});

describe("findIn", () => {
  const terms: Term[] = [
    { text: "SALES_ORDERS_SYNTH", source: "saved scans", kind: "word" },
    { text: "ZX_", source: "notes.local.md", kind: "prefix" },
  ];
  const matches = (text: string) => findIn({ where: "x:1", text }, buildMatcher(terms)).map((h) => `${h.match} [${h.source}]`);

  it("finds names ignoring case, as whole words only", () => {
    expect(matches("select * from sales_orders_synth")).toEqual(["sales_orders_synth [saved scans]"]);
    expect(matches("SALES_ORDERS_SYNTH_V and XSALES_ORDERS_SYNTH")).toEqual([]);
  });

  it("finds prefixes at the start of a name, ignoring case", () => {
    expect(matches("ZX_ORDERS_V, zx_items")).toEqual(["ZX_ORDERS_V [notes.local.md]", "zx_items [notes.local.md]"]);
    expect(matches("AZX_ORDERS")).toEqual([]);
  });

  it("marks plain object names, unless a note or scan.local.json also has them in any case", () => {
    const list: Term[] = [
      { text: "User", source: "saved scans", kind: "word", plain: true },
      { text: "Position", source: "saved scans", kind: "word", plain: true },
      { text: "POSITION", source: "tenant-conventions.local.md", kind: "word" },
    ];
    const found = findIn({ where: "x:1", text: "interface User { position: string }" }, buildMatcher(list));
    expect(found.map((h) => `${h.match} [${h.source}] ${h.plain ? "plain" : "blocks"}`)).toEqual(["User [saved scans] plain", "position [tenant-conventions.local.md] blocks"]);
  });

  it("finds real hosts and addresses, not examples", () => {
    expect(matches(`https://${host("acme")}/ and ${address("acme-synth.eu")}`)).toEqual([`${host("acme")} [Datasphere host]`, `${address("acme-synth.eu")} [email address]`]);
    expect(matches("https://your-tenant.eu10.hcs.cloud.sap, name@example.com, noreply@github.com, page@1440.png")).toEqual([]);
  });
});
