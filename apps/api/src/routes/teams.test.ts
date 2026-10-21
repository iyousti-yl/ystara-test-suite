import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { TeamsMessage } from "@ystara/shared";
import { teamsChannelSecretContext } from "@ystara/shared/secrets";
import { testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { buildServer } from "../server.js";

let db: Db;
let app: FastifyInstance;
let admin: TestUser;
let developer: TestUser;
const posts: { url: string; message: TeamsMessage }[] = [];
let teamsAnswers: "ok" | "refused" = "ok";

beforeAll(async () => {
  db = await createTestDb();
  const teams = async (url: string, message: TeamsMessage) => {
    if (teamsAnswers === "refused") throw new Error("Teams refused the post (HTTP 404). The webhook may have been deleted or turned off in Teams.");
    posts.push({ url, message });
  };
  app = await buildServer({ db, queue: { send: async () => undefined }, secrets: testSecrets, teams }, { logger: false });
  admin = await testUser(db, { account: "Customer", email: "admin@customer.example.com", role: "admin" });
  developer = await testUser(db, { account: "Customer", email: "developer@customer.example.com", role: "developer" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, as: TestUser, payload?: object) =>
  app.inject({ method, url: `/api${url}`, headers: { cookie: as.cookie }, payload });
const WEBHOOK = "https://default0a1b.2c.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SECRET";

describe("the account's Teams channel", () => {
  it("is saved by an admin after a test post, sealed, and never shown again", async () => {
    expect((await call("GET", "/account/teams-channel", admin)).json()).toEqual({ channel: null });
    const res = await call("PUT", "/account/teams-channel", admin, { url: WEBHOOK });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ channel: { host: "default0a1b.2c.environment.api.powerplatform.com", updatedAt: expect.any(String), updatedBy: "admin@customer.example.com" } });
    expect(res.body).not.toContain("SECRET");
    expect(posts).toEqual([{ url: WEBHOOK, message: expect.objectContaining({ title: "Ystara is connected to this channel", subtitle: "Account Customer" }) }]);

    const { rows } = await db.query<{ sealed: string }>("select sealed from teams_channels where account_id = $1", [admin.accountId]);
    expect(rows[0]!.sealed).not.toContain("SECRET");
    expect(testSecrets.open(rows[0]!.sealed, teamsChannelSecretContext(admin.accountId))).toBe(WEBHOOK);

    expect((await call("POST", "/account/teams-channel/test", admin)).statusCode).toBe(204);
    expect(posts).toHaveLength(2);
    expect((await call("DELETE", "/account/teams-channel", admin)).statusCode).toBe(204);
    expect((await call("GET", "/account/teams-channel", admin)).json()).toEqual({ channel: null });
  });

  it("takes only Microsoft's webhook addresses, keeps nothing when Teams refuses the test, and is for admins only", async () => {
    for (const url of ["http://org.webhook.office.com/webhookb2/x", "https://169.254.169.254/latest", "https://example.com/webhook", "https://org.webhook.office.com.example.com/x"]) {
      const res = await call("PUT", "/account/teams-channel", admin, { url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toMatch(/^This isn't the address of a Teams webhook/);
    }
    teamsAnswers = "refused";
    const refused = await call("PUT", "/account/teams-channel", admin, { url: "https://org.webhook.office.com/webhookb2/x" });
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toBe("Teams refused the post (HTTP 404). The webhook may have been deleted or turned off in Teams. Nothing was saved.");
    expect((await call("GET", "/account/teams-channel", admin)).json()).toEqual({ channel: null });
    teamsAnswers = "ok";

    expect((await call("GET", "/account/teams-channel", developer)).statusCode).toBe(403);
    expect((await call("PUT", "/account/teams-channel", developer, { url: WEBHOOK })).statusCode).toBe(403);
  });
});
