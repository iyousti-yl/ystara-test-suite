import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { testSecrets, testUser } from "./auth/testing.js";
import { buildServer, trustProxyFromEnv } from "./server.js";

// A stand-in for apps/web/dist: index.html plus one hashed asset.
const webRoot = mkdtempSync(path.join(tmpdir(), "ystara-web-"));
mkdirSync(path.join(webRoot, "assets"));
writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Ystara</title>");
writeFileSync(path.join(webRoot, "assets", "index-abc123.js"), "console.log(1)");

let db: Db;
let withWeb: FastifyInstance;
let apiOnly: FastifyInstance;
const deps = () => ({ db, queue: { send: async () => undefined }, secrets: testSecrets });

beforeAll(async () => {
  db = await createTestDb();
  withWeb = await buildServer(deps(), { logger: false, webRoot });
  apiOnly = await buildServer(deps(), { logger: false });
});
afterAll(async () => {
  await withWeb.close();
  await apiOnly.close();
  await db.close();
  rmSync(webRoot, { recursive: true, force: true });
});

const html = { accept: "text/html,application/xhtml+xml" };

describe("one port for the API and the web app", () => {
  it("serves the API under /api", async () => {
    expect((await withWeb.inject("/api/health")).json().status).toBe("ok");
  });

  it("serves the web app, and its pages as index.html so links and reloads work", async () => {
    for (const url of ["/", "/tenants/00000000-0000-4000-8000-000000000000", "/scans/x/pipeline?output=S.V"]) {
      const res = await withWeb.inject({ url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain("<title>Ystara</title>");
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("lets browsers keep hashed assets", async () => {
    const res = await withWeb.inject("/assets/index-abc123.js");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("lets the browser load fonts and styles only from Ystara itself", async () => {
    const csp = (await withWeb.inject({ url: "/", headers: html })).headers["content-security-policy"] as string;
    const directives = new Map(csp.split(";").map((d) => [d.trim().split(" ")[0], d.trim().split(" ").slice(1)]));
    expect(directives.get("font-src")).toEqual(["'self'", "data:"]);
    expect(directives.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(csp).not.toContain("https:");
    expect(directives.has("upgrade-insecure-requests")).toBe(false);
  });

  it("answers unknown API routes with JSON, never with the page", async () => {
    const res = await withWeb.inject({ url: "/api/nope", headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("GET /api/nope not found");
  });

  it("works without a built web app", async () => {
    expect((await apiOnly.inject({ url: "/", headers: html })).statusCode).toBe(404);
    expect((await apiOnly.inject("/api/health")).statusCode).toBe(200);
  });
});

describe("JSON bodies", () => {
  const login = (payload: string) => apiOnly.inject({ method: "POST", url: "/api/auth/login", payload, headers: { "content-type": "application/json" } });

  it("are still refused when they don't parse or set __proto__ or constructor", async () => {
    for (const payload of ['{"email":', '{"__proto__":{"admin":true},"email":"a@example.com","password":"x"}', '{"constructor":{"prototype":{}}}']) {
      expect((await login(payload)).statusCode, payload).toBe(400);
    }
  });

  it("may be empty: an empty body is no body, which the route's own check refuses where it needs one", async () => {
    const res = await login("");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request");
  });
});

describe("the log", () => {
  it("never holds the token of an invitation or reset link", async () => {
    const lines: string[] = [];
    const stream = new PassThrough().on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    const logged = await buildServer(deps(), { logStream: stream, webRoot });
    const token = "t".repeat(43);
    await logged.inject(`/api/invitations/${token}`);
    await logged.inject({ method: "POST", url: `/api/invitations/${token}/accept?x=1`, payload: {} });
    await logged.inject({ url: `/invite/${token}`, headers: html });
    await logged.inject(`/api/resets/${token}`);
    await logged.inject({ url: `/reset/${token}`, headers: html });
    await logged.close();

    const log = lines.join("");
    expect(log).not.toContain(token);
    expect(log).toContain('"url":"/api/invitations/<token>"');
    expect(log).toContain('"url":"/api/invitations/<token>/accept?x=1"');
    expect(log).toContain('"url":"/invite/<token>"');
    expect(log).toContain('"url":"/api/resets/<token>"');
    expect(log).toContain('"url":"/reset/<token>"');
  });
});

describe("the client's address", () => {
  const login = (app: FastifyInstance, forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.0.0.2",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { email: "shared@example.com", password: "wrong password!" },
    });

  it("comes from the proxy only when YSTARA_TRUST_PROXY says so, so limits count per real client", async () => {
    await testUser(db, { account: "Proxied", email: "shared@example.com", role: "viewer" }); // a cheap hash keeps this quick
    const proxied = await buildServer(deps(), { logger: false, trustProxy: trustProxyFromEnv("1") });
    for (let i = 0; i < 10; i++) await login(proxied, "203.0.113.1");
    expect((await login(proxied, "203.0.113.1")).statusCode).toBe(429);
    expect((await login(proxied, "203.0.113.2")).statusCode).toBe(401);
    await proxied.close();

    // Not trusted: a client can't escape its limit by sending another address.
    const direct = await buildServer(deps(), { logger: false });
    for (let i = 0; i < 10; i++) await login(direct, "203.0.113.1");
    expect((await login(direct, "203.0.113.2")).statusCode).toBe(429);
    await direct.close();
  });

  it("is set deliberately: a count of proxies or their addresses, never everyone", () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv(" ")).toBe(false);
    expect(trustProxyFromEnv("2")).toBe(2);
    expect(trustProxyFromEnv("10.0.0.0/8, 127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(() => trustProxyFromEnv("true")).toThrow(/number \(e\.g\. 1\) or their addresses/);
  });
});
