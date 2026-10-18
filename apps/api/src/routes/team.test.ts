import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "@ystara/db";
import { createTestDb } from "@ystara/db/testing";
import type { Team } from "@ystara/shared";
import { testSecrets, testUser, type TestUser } from "../auth/testing.js";
import { buildServer } from "../server.js";

let db: Db;
let app: FastifyInstance;
let admin: TestUser;

beforeAll(async () => {
  db = await createTestDb();
  app = await buildServer({ db, queue: { send: async () => undefined }, secrets: testSecrets }, { logger: false });
  admin = await testUser(db, { account: "Team", email: "admin@team.example.com", role: "admin" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, as: TestUser = admin) =>
  app.inject({ method, url: `/api${url}`, payload, headers: { cookie: as.cookie } });
const team = async (): Promise<Team> => (await call("GET", "/team")).json();

describe("the account admin page", () => {
  it("invites people with a role, and the link is shown only once", async () => {
    const res = await call("POST", "/team/invitations", { email: "Dev@Team.example.com", role: "developer" });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listed = (await team()).invitations.find((i) => i.email === "dev@team.example.com")!;
    expect(listed).toMatchObject({ role: "developer" });
    expect(JSON.stringify(await team())).not.toContain(res.json().token);

    expect((await call("DELETE", `/team/invitations/${listed.id}`)).statusCode).toBe(204);
    expect((await team()).invitations.some((i) => i.id === listed.id)).toBe(false);
    expect((await call("POST", "/team/invitations", { email: "admin@team.example.com", role: "viewer" })).statusCode).toBe(409);
    expect((await call("POST", "/team/invitations", { email: "not an email", role: "viewer" })).statusCode).toBe(400);
    expect((await call("POST", "/team/invitations", { email: "x@example.com", role: "owner" })).statusCode).toBe(400);
  });

  it("changes roles and removes members, but never the last admin", async () => {
    const dev = await testUser(db, { account: "Team", email: "dev2@team.example.com", role: "developer" });
    expect((await call("PATCH", `/team/members/${admin.userId}`, { role: "viewer" })).statusCode).toBe(409);
    expect((await call("DELETE", `/team/members/${admin.userId}`)).json().error).toMatch(/at least one admin/);

    expect((await call("PATCH", `/team/members/${dev.userId}`, { role: "test_coordinator" })).statusCode).toBe(204);
    expect((await team()).members.find((m) => m.userId === dev.userId)?.role).toBe("test_coordinator");
    // The new role applies at once, without signing in again.
    expect((await call("GET", "/auth/me", undefined, dev)).json().role).toBe("test_coordinator");

    expect((await call("DELETE", `/team/members/${dev.userId}`)).statusCode).toBe(204);
    expect((await call("GET", "/auth/me", undefined, dev)).statusCode).toBe(401);
    expect((await call("DELETE", `/team/members/${dev.userId}`)).statusCode).toBe(404);
  });

  it("renames the account, which its members see at once; names stay unique", async () => {
    const dev = await testUser(db, { account: "Team", email: "dev-rename@team.example.com", role: "developer" });
    await testUser(db, { account: "Taken name", email: "admin@taken.example.com", role: "admin" });
    expect((await call("PATCH", "/team/account", { name: "Renamed by dev" }, dev)).statusCode).toBe(403);
    expect((await call("PATCH", "/team/account", { name: "  " })).statusCode).toBe(400);
    expect((await call("PATCH", "/team/account", { name: "Taken name" })).statusCode).toBe(409);

    const res = await call("PATCH", "/team/account", { name: "  Team renamed " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Team renamed" });
    expect((await call("GET", "/auth/me", undefined, dev)).json().account.name).toBe("Team renamed");
    await call("PATCH", "/team/account", { name: "Team" });
  });

  it("is for admins only", async () => {
    const dev = await testUser(db, { account: "Team", email: "dev3@team.example.com", role: "developer" });
    expect((await call("GET", "/team", undefined, dev)).statusCode).toBe(403);
    expect((await call("POST", "/team/invitations", { email: "friend@example.com", role: "admin" }, dev)).statusCode).toBe(403);
    expect((await call("PATCH", `/team/members/${dev.userId}`, { role: "admin" }, dev)).statusCode).toBe(403);
  });

  it("only sees and changes its own account", async () => {
    const other = await testUser(db, { account: "Other team", email: "admin@other.example.com", role: "admin" });
    const theirs = await testUser(db, { account: "Other team", email: "member@other.example.com", role: "developer" });
    expect((await team()).members.map((m) => m.email)).not.toContain("member@other.example.com");
    expect((await call("PATCH", `/team/members/${theirs.userId}`, { role: "viewer" })).statusCode).toBe(404);
    expect((await call("DELETE", `/team/members/${theirs.userId}`)).statusCode).toBe(404);
    const invite = (await call("POST", "/team/invitations", { email: "x@other.example.com", role: "viewer" }, other)).json();
    expect((await call("DELETE", `/team/invitations/${invite.invitation.id}`)).statusCode).toBe(404);
  });
});
