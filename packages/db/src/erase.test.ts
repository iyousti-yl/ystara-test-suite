import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvitation, createAccount, createInvitation, createSession, findSession, findUserByEmail } from "./accounts.js";
import { listAuditEvents, recordAuditEvent } from "./audit.js";
import type { Db } from "./db.js";
import { accountFootprint, deleteAccount, eraseUser } from "./erase.js";
import { createSignOff, listSignOffs } from "./history.js";
import { createPipeline } from "./pipelines.js";
import { createScan } from "./scans.js";
import { createTenant, listTenants } from "./tenants.js";
import { createTestDb } from "./testing.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const newUser = (n: number) => ({ newUser: { passwordHash: `hash-${n}`, totpSecret: `sealed-${n}`, totpStep: 0 } });
async function join(accountId: string, email: string, role: "admin" | "developer", n: number) {
  const { token } = await createInvitation(db, { accountId, email, role });
  const existing = await findUserByEmail(db, email);
  return (await acceptInvitation(db, token, existing ? { existingUserId: existing.id } : newUser(n)))!.userId;
}

describe("erasing a user", () => {
  it("removes their sign-in and name everywhere, and keeps what the account did", async () => {
    const account = await createAccount(db, "Erasing");
    await join(account.id, "boss@erasing.example.com", "admin", 1);
    const leaver = await join(account.id, "leaver@erasing.example.com", "admin", 2);
    const session = await createSession(db, { userId: leaver, accountId: account.id, verified: true, minutes: 60 });
    const tenant = await createTenant(db, { accountId: account.id, name: "Erasing", host: null });
    const pipeline = await createPipeline(db, { tenantId: tenant.id, name: "Kept", output: { space: "SALES", technicalName: "V_OUT" }, excludeWriters: [] });
    await createSignOff(db, { tenantId: tenant.id, pipelineId: pipeline.id, verdict: "approved", comment: "", userId: leaver });
    await recordAuditEvent(db, { accountId: account.id, userId: leaver, action: "POST /tenants", target: null, detail: null, ip: "192.0.2.7" });
    await recordAuditEvent(db, {
      accountId: account.id,
      userId: null,
      action: "POST /team/invitations",
      target: { kind: "invitation", id: "00000000-0000-4000-8000-000000000001", name: "leaver@erasing.example.com" },
      detail: { email: "leaver@erasing.example.com", role: "admin" },
      ip: null,
    });

    expect(await eraseUser(db, " Leaver@Erasing.example.com")).toEqual({ erased: true, accounts: ["Erasing"] });
    expect(await findUserByEmail(db, "leaver@erasing.example.com")).toBeUndefined();
    expect(await findSession(db, session)).toBeUndefined();
    const events = await listAuditEvents(db, { accountId: account.id, limit: 10 });
    expect(JSON.stringify(events)).not.toContain("leaver@");
    expect(JSON.stringify(events)).not.toContain("192.0.2.7");
    expect(events.map((e) => e.action)).toEqual(["POST /team/invitations", "POST /tenants"]);
    expect(events[0]).toMatchObject({ target: { name: null }, detail: { role: "admin" } });
    expect((await listSignOffs(db, pipeline.id))[0]).toMatchObject({ verdict: "approved", signedBy: "erased user" });

    expect(await eraseUser(db, "leaver@erasing.example.com")).toEqual({ erased: false, reason: "unknown" });
  });

  it("is refused while they are an account's only admin", async () => {
    const account = await createAccount(db, "Alone");
    await join(account.id, "alone@alone.example.com", "admin", 3);
    expect(await eraseUser(db, "alone@alone.example.com")).toEqual({ erased: false, reason: "only_admin", accounts: ["Alone"] });
    expect(await findUserByEmail(db, "alone@alone.example.com")).toBeDefined();
  });
});

describe("deleting an account", () => {
  it("removes its tenants with everything in them, and says whose sign-in is left over", async () => {
    const account = await createAccount(db, "Leaving customer");
    const other = await createAccount(db, "Staying customer");
    await join(account.id, "only@leaving.example.com", "admin", 4);
    await join(account.id, "both@staying.example.com", "admin", 5);
    await join(other.id, "both@staying.example.com", "admin", 5);
    const tenant = await createTenant(db, { accountId: account.id, name: "Leaving", host: null });
    await createScan(db, tenant.id, ["SALES"], "import");
    await createPipeline(db, { tenantId: tenant.id, name: "Gone", output: { space: "SALES", technicalName: "V_OUT" }, excludeWriters: [] });

    expect(await accountFootprint(db, "Leaving customer")).toEqual({ id: account.id, name: "Leaving customer", tenants: 1, members: 2, scans: 1, pipelines: 1, onlyHere: ["only@leaving.example.com"] });
    expect(await deleteAccount(db, account.id)).toBe(true);
    expect(await accountFootprint(db, "Leaving customer")).toBeUndefined();
    expect(await listTenants(db, account.id)).toEqual([]);
    expect((await db.query("select count(*)::int as n from scans where tenant_id = $1", [tenant.id])).rows[0]).toEqual({ n: 0 });
    expect(await accountFootprint(db, "Staying customer")).toMatchObject({ members: 1 });
  });
});
