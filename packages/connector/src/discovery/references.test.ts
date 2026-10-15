import { describe, expect, it } from "vitest";
import { componentRole, extractReferences, stripSqlComments } from "./references.js";

describe("componentRole", () => {
  it("tells writing flow steps from reading ones by their component", () => {
    expect(componentRole("com.sap.database.table.producer")).toBe("target");
    expect(componentRole("com.sap.dwc.target")).toBe("target");
    expect(componentRole("com.sap.application.consumer.v2")).toBe("source");
    expect(componentRole("com.sap.database.table.consumer")).toBe("source");
    expect(componentRole("com.sap.dataflow.projection")).toBeUndefined();
  });
});

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    const sql = 'SELECT 1 FROM "A" -- JOIN "B"\n/* JOIN "C"\n JOIN "D" */ JOIN "E"';
    const out = stripSqlComments(sql);
    expect(out).toContain('"A"');
    expect(out).toContain('"E"');
    for (const gone of ['"B"', '"C"', '"D"']) expect(out).not.toContain(gone);
  });

  it("keeps comment markers inside string literals and quoted identifiers", () => {
    const sql = `SELECT '--', 'it''s /* not */ a comment' FROM "X--Y" JOIN "Z"`;
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it("handles a comment that runs to the end of the text", () => {
    expect(stripSqlComments('SELECT 1 FROM "A" /* "B"').trim()).toBe('SELECT 1 FROM "A"');
  });
});

describe("extractReferences", () => {
  const known = new Set(["T_IN", "T_OUT", "T_OLD"]);

  it("reads a write step's role from its component, not its name", () => {
    const flow = {
      dataflows: {
        DF: {
          contents: {
            processes: {
              consumer1: { component: "com.sap.database.table.consumer", metadata: { config: { dwcEntity: "T_IN" } } },
              producer1: { component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: "T_OUT" } } },
            },
          },
        },
      },
    };
    expect(extractReferences(flow, "DF", "data_flow", known)).toEqual(
      expect.arrayContaining([
        { name: "T_IN", role: "source" },
        { name: "T_OUT", role: "target" },
      ]),
    );
  });

  it("does not see names in commented-out SQL", () => {
    const view = { definitions: { V: { "@DataWarehouse.sqlEditor.query": 'SELECT * FROM "T_IN" -- JOIN "T_OLD"' } } };
    expect(extractReferences(view, "V", "sql_view", known)).toEqual([{ name: "T_IN", role: "source" }]);
  });
});
