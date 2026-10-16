import { describe, expect, it } from "vitest";
import { maskSecrets } from "./mask.js";

// Synthetic, with the characters a real secret has that URL encoding changes.
const client = { clientId: "sb-synthetic!b1|client!b2", clientSecret: "synthetic$Secret+/=value" };
const b64 = (text: string) => Buffer.from(text).toString("base64");
const b64url = (text: string) => Buffer.from(text).toString("base64url");
const jwt = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"synthetic"}')}.c2lnbmF0dXJlLXN5bnRoZXRpYw`;

describe("masking secrets in what the CLI printed", () => {
  it("hides the client's secret in every form", () => {
    for (const form of [
      client.clientSecret,
      encodeURIComponent(client.clientSecret),
      encodeURIComponent(client.clientSecret).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()), // %2b instead of %2B
      b64(client.clientSecret),
      b64(client.clientSecret).replace(/=+$/, ""),
      b64url(client.clientSecret),
      b64(`${client.clientId}:${client.clientSecret}`),
      b64url(`${client.clientId}:${client.clientSecret}`),
      b64(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`),
    ]) {
      const masked = maskSecrets(`before ${form} after`, client);
      expect(masked, form).toBe("before <secret> after");
    }
  });

  it("hides tokens and credentials it doesn't know, in headers, JSON, query strings and forms", () => {
    const cases: [string, string][] = [
      [`Authorization: Bearer ${jwt}`, "Authorization: Bearer <secret>"],
      ["authorization: bearer abcdefghijklmnop1234", "authorization: bearer <secret>"],
      [`Authorization: Basic ${b64("other-client:other-secret")}`, "Authorization: Basic <secret>"],
      [`token ${jwt} expired`, "token <secret> expired"],
      ['{"access_token":"opaque-token-1","token_type":"bearer"}', '{"access_token":"<secret>","token_type":"bearer"}'],
      ['{ "refresh_token": "r-1\\"x", "expires_in": 3600 }', '{ "refresh_token": "<secret>", "expires_in": 3600 }'],
      ["{ client_secret: 'other-secret' }", "{ client_secret: '<secret>' }"],
      ["GET /x?access_token=opaque-2&space=SALES", "GET /x?access_token=<secret>&space=SALES"],
      ["grant_type=client_credentials&client_id=sb-x&client_secret=other%24secret", "grant_type=client_credentials&client_id=sb-x&client_secret=<secret>"],
      ['clientSecret: "cut off', 'clientSecret: "<secret>'],
      ["id_token: opaque-3", "id_token: <secret>"],
    ];
    for (const [text, masked] of cases) expect(maskSecrets(text), text).toBe(masked);
  });

  it("leaves ordinary words alone", () => {
    const text = "Basic authentication failed. Bearer token missing. client_id=sb-x space=SALES 401 Unauthorized";
    expect(maskSecrets(text, client)).toBe(text);
  });
});
