import { describe, expect, it } from "vitest";
import { isDatasphereUrl, isTokenUrl } from "./urls.js";

/** A URL with a user name before the host, built from parts so it never reads as an email address. */
const withUser = (user: string, rest: string) => `https://${user}@${rest}`;

describe("a Datasphere tenant URL", () => {
  it("is https on hcs.cloud.sap", () => {
    for (const url of ["https://synthetic.eu10.hcs.cloud.sap", "https://synthetic.eu10.hcs.cloud.sap/", "https://SYNTHETIC.eu10.hcs.cloud.sap", "https://synthetic.eu10.hcs.cloud.sap:443"]) {
      expect(isDatasphereUrl(url), url).toBe(true);
    }
  });

  it("is nothing else: no other host, port, path, query, fragment or user name", () => {
    for (const url of [
      "http://synthetic.eu10.hcs.cloud.sap",
      "https://synthetic.example.com",
      "https://hcs.cloud.sap",
      "https://synthetic.eu10.hcs.cloud.sap.example.com",
      "https://synthetic.eu10.hcs.cloud.sap.",
      "https://10.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://synthetic.eu10.hcs.cloud.sap:8443",
      "https://synthetic.eu10.hcs.cloud.sap/dwaas-core/index.html",
      "https://synthetic.eu10.hcs.cloud.sap/?x=1",
      "https://synthetic.eu10.hcs.cloud.sap/#/home",
      withUser("user:pass", "synthetic.eu10.hcs.cloud.sap"),
      withUser("synthetic.example.com", "synthetic.eu10.hcs.cloud.sap"),
      "synthetic.eu10.hcs.cloud.sap",
      "not a url",
    ]) {
      expect(isDatasphereUrl(url), url).toBe(false);
    }
  });
});

describe("a token URL", () => {
  it("is SAP's sign-in service for the tenant, at /oauth/token", () => {
    for (const url of [
      "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token",
      "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token/",
      "https://synthetic.authentication.us10-004.hana.ondemand.com/oauth/token",
    ]) {
      expect(isTokenUrl(url), url).toBe(true);
    }
  });

  it("is no other host on hana.ondemand.com, nor any other address", () => {
    for (const url of [
      "http://synthetic.authentication.eu10.hana.ondemand.com/oauth/token",
      "https://synthetic.cfapps.eu10.hana.ondemand.com/oauth/token",
      "https://synthetic.authentication.cfapps.eu10.hana.ondemand.com/oauth/token",
      "https://synthetic.authentication.eu10.hana.ondemand.com.example.com/oauth/token",
      "https://authentication.eu10.hana.ondemand.com/oauth/token",
      "https://synthetic.authentication.eu10.hana.ondemand.com:8443/oauth/token",
      "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/authorize",
      "https://synthetic.authentication.eu10.hana.ondemand.com/oauth/token?grant_type=client_credentials",
      withUser("user", "synthetic.authentication.eu10.hana.ondemand.com/oauth/token"),
      "https://10.0.0.1/oauth/token",
      "https://synthetic.example.com/oauth/token",
      "not a url",
    ]) {
      expect(isTokenUrl(url), url).toBe(false);
    }
  });
});
