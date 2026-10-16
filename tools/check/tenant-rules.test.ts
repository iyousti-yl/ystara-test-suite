import path from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, buildMatcher, findIn, longEnough, placeholderHost, refusedFile, type Term } from "./tenant-rules.js";

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

  it("refuses scan and check output, and .env files outside the repository", () => {
    expect(refused("tools/scan/output/run-1/lineage.md")).toBe(true);
    expect(refused("tools/check/output/browser-1/report.json")).toBe(true);
    expect(refused(path.resolve("/elsewhere/.env"))).toBe(true);
  });

  it("reads anything else", () => {
    expect(refused("pr-body.md")).toBe(false);
    expect(refused("docs/env-notes.md")).toBe(false);
    expect(refused(path.resolve("/tmp/pr-body.md"))).toBe(false);
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

  it("finds real hosts and addresses, not examples", () => {
    expect(matches(`https://${host("acme")}/ and ${address("acme-synth.eu")}`)).toEqual([`${host("acme")} [Datasphere host]`, `${address("acme-synth.eu")} [email address]`]);
    expect(matches("https://your-tenant.eu10.hcs.cloud.sap, name@example.com, noreply@github.com, page@1440.png")).toEqual([]);
  });
});
