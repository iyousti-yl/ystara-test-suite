import { describe, expect, it } from "vitest";
import { databaseUserProblem, databaseUserSpace, isDatabaseHost, measurability, type DatabaseUserReach } from "./database-users.js";
import type { DspObjectRef } from "./objects.js";

describe("a database user's name", () => {
  it("accepts SPACE#SUFFIX and refuses a name a settings file cut short", () => {
    expect(databaseUserProblem("SALES#SYNTH")).toBeUndefined();
    for (const user of ["SALES", "SALES#", "#SYNTH", "SALES#A#B", "SALES #SYNTH", ""]) {
      expect(databaseUserProblem(user), user).toBe("database user names look like SPACE#SUFFIX");
    }
    expect(databaseUserSpace("SALES#SYNTH")).toBe("SALES");
  });
});

describe("a database host", () => {
  it("is SAP HANA Cloud, as the user's details show it", () => {
    for (const host of ["synthetic.hana.prod-eu10.hanacloud.ondemand.com", "synthetic.hna1.prod-eu10.hanacloud.ondemand.com", "synthetic.hna12.prod-eu10.hanacloud.ondemand.com"]) {
      expect(isDatabaseHost(host), host).toBe(true);
    }
    for (const host of [
      "synthetic.hna.prod-eu10.hanacloud.ondemand.com",
      "synthetic.hnax.prod-eu10.hanacloud.ondemand.com",
      "synthetic.hna1.hana.prod-eu10.hanacloud.ondemand.com",
      "https://synthetic.hana.prod-eu10.hanacloud.ondemand.com",
      "synthetic.hana.prod-eu10.hanacloud.ondemand.com:443",
      "synthetic.hana.prod-eu10.hanacloud.ondemand.com.example.com",
      "synthetic.cfapps.eu10.hana.ondemand.com",
      "synthetic.eu10.hcs.cloud.sap",
      ["hana", "prod-eu10", "hanacloud", "ondemand", "com"].join("."), // no id; built from parts so it doesn't read as a tenant's host
      "10.0.0.1",
      "localhost",
      "",
    ]) {
      expect(isDatabaseHost(host), host).toBe(false);
    }
  });
});

describe("whether a snapshot can measure a step", () => {
  const view = (space: string, technicalName: string): DspObjectRef => ({ space, technicalName, type: "graphical_view" });
  const sales = (status: DatabaseUserReach["status"], visible: string[] | null): DatabaseUserReach => ({
    space: "SALES",
    status,
    visible: visible && visible.map((name) => ({ name })),
  });

  it("comes from what the space's database user saw", () => {
    expect(measurability(view("SALES", "ORDERS_SYNTH_V"), [sales("connected", ["ORDERS_SYNTH_V"])])).toEqual({ measurable: true });
    expect(measurability(view("SALES", "STAGING_SYNTH_V"), [sales("connected", ["ORDERS_SYNTH_V"])])).toEqual({ measurable: false, reason: "not-visible" });
    expect(measurability({ space: "SALES", technicalName: "ORDERS_SYNTH", type: "local_table" }, [sales("connected", ["ORDERS_SYNTH_V"])])).toEqual({
      measurable: false,
      reason: "not-visible",
    });
  });

  it("keeps the last check's list while the user is checked again, and says why when there is none", () => {
    expect(measurability(view("SALES", "ORDERS_SYNTH_V"), [sales("checking", ["ORDERS_SYNTH_V"])])).toEqual({ measurable: true });
    expect(measurability(view("SALES", "ORDERS_SYNTH_V"), [sales("checking", null)])).toEqual({ measurable: false, reason: "not-checked" });
    expect(measurability(view("SALES", "ORDERS_SYNTH_V"), [sales("failed", ["ORDERS_SYNTH_V"])])).toEqual({ measurable: false, reason: "check-failed" });
    expect(measurability(view("FINANCE", "ORDERS_SYNTH_V"), [sales("connected", ["ORDERS_SYNTH_V"])])).toEqual({ measurable: false, reason: "no-database-user" });
  });

  it("never measures a flow or task chain: they hold no data of their own", () => {
    for (const type of ["data_flow", "transformation_flow", "replication_flow", "task_chain"] as const) {
      expect(measurability({ space: "SALES", technicalName: "ORDERS_SYNTH_V", type }, [sales("connected", ["ORDERS_SYNTH_V"])])).toEqual({ measurable: false, reason: "process" });
    }
  });
});
