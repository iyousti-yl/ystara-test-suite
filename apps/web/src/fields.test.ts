import { DATASPHERE_URL_HINT, TOKEN_URL_HINT } from "@ystara/shared";
import { describe, expect, it } from "vitest";
import { datasphereUrlProblem, MAX_SPACES, parseSpaceIds, spaceIdsOf, tokenUrlProblem } from "./fields";
import { fileNameOf } from "./files";

describe("a field checked before it is sent", () => {
  it("says nothing while it is empty or right", () => {
    expect(datasphereUrlProblem("")).toBeUndefined();
    expect(datasphereUrlProblem("  ")).toBeUndefined();
    expect(datasphereUrlProblem("https://synthetic.eu10.hcs.cloud.sap")).toBeUndefined();
    expect(tokenUrlProblem("")).toBeUndefined();
    expect(tokenUrlProblem("https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token")).toBeUndefined();
  });

  it("gives the API's own hint for an address that isn't one", () => {
    expect(datasphereUrlProblem("https://example.com")).toBe(DATASPHERE_URL_HINT);
    expect(datasphereUrlProblem("synthetic.eu10")).toBe(DATASPHERE_URL_HINT);
    expect(tokenUrlProblem("https://synthetic.eu10.hcs.cloud.sap")).toBe(TOKEN_URL_HINT);
  });
});

describe("space IDs typed by hand", () => {
  it("are split on commas and spaces, in upper case, each once", () => {
    expect(parseSpaceIds("SALES, stock;HR  ")).toEqual(["SALES", "stock", "HR"]);
    expect(spaceIdsOf("sales, SALES, Stock")).toEqual({ spaces: ["SALES", "STOCK"] });
    expect(spaceIdsOf("")).toEqual({ spaces: [] });
  });

  it("say what is wrong with them", () => {
    expect(parseSpaceIds("SALES, HR-EU")).toBeUndefined();
    expect(spaceIdsOf("SALES, HR-EU").problem).toBe("Space IDs contain only letters, digits and underscores; separate them with commas.");
    const many = Array.from({ length: MAX_SPACES + 1 }, (_, i) => `S${i}`).join(", ");
    expect(spaceIdsOf(many).problem).toBe(`At most ${MAX_SPACES} spaces at a time.`);
  });
});

describe("a download's file name", () => {
  it("is the one the API gives, or the fallback", () => {
    expect(fileNameOf('attachment; filename="ystara-history-Monthly-sales.csv"', "history.csv")).toBe("ystara-history-Monthly-sales.csv");
    expect(fileNameOf("attachment; filename=ystara-audit-2026-10-23.csv", "audit.csv")).toBe("ystara-audit-2026-10-23.csv");
    expect(fileNameOf("attachment", "audit.csv")).toBe("audit.csv");
    expect(fileNameOf(null, "audit.csv")).toBe("audit.csv");
  });
});
