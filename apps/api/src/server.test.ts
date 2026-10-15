import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import { buildServer } from "./server.js";

// A stand-in for apps/web/dist: index.html plus one hashed asset.
const webRoot = mkdtempSync(path.join(tmpdir(), "ystara-web-"));
mkdirSync(path.join(webRoot, "assets"));
writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Ystara</title>");
writeFileSync(path.join(webRoot, "assets", "index-abc123.js"), "console.log(1)");

let db: Db;
let withWeb: FastifyInstance;
let apiOnly: FastifyInstance;
const queue = { send: async () => undefined };

beforeAll(async () => {
  db = await createTestDb();
  withWeb = await buildServer({ db, queue }, { logger: false, webRoot });
  apiOnly = await buildServer({ db, queue }, { logger: false });
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
