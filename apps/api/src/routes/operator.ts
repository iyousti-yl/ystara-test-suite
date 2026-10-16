import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAccount, createInvitation, createSignInReset, getAccount, listAccountOverviews, listMembers, listUserOverviews, type Db } from "@ystara/db";
import type { AccountOverview, CreatedInvitation, CreatedReset, UserOverview } from "@ystara/shared";

/**
 * The operator panel, under /api/operator: every customer account and user,
 * for whoever runs Ystara (users.operator, set with `npm run operator:grant`).
 * It shows counts and memberships, never tenants, scans or pipelines, and it
 * can create an account with its first admin, invite another admin to an
 * account, and make a reset link for someone who lost their password or phone.
 */
const operator = { access: "operator" } as const;
const email = z.string().trim().toLowerCase().email().max(254);
const NewAccount = z.object({ name: z.string().trim().min(1).max(100), adminEmail: email });
const AdminInvitation = z.object({ email });
const id = z.object({ id: z.string().uuid() });

export function operatorRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    app.get("/operator/accounts", { config: operator }, async () => (await listAccountOverviews(db)) satisfies AccountOverview[]);

    // The same as `npm run account:create`: the account and an invitation link for its first admin.
    app.post("/operator/accounts", { config: operator }, async (req, reply) => {
      const input = NewAccount.parse(req.body);
      const account = await createAccount(db, input.name);
      const created = await createInvitation(db, { accountId: account.id, email: input.adminEmail, role: "admin" });
      return reply.code(201).send({ account, ...created } satisfies CreatedInvitation & { account: { id: string; name: string } });
    });

    // Another admin for an account, e.g. when its only admin left the company.
    app.post("/operator/accounts/:id/invitations", { config: operator }, async (req, reply) => {
      const accountId = id.parse(req.params).id;
      if (!(await getAccount(db, accountId))) return reply.code(404).send({ error: "Account not found" });
      const input = AdminInvitation.parse(req.body);
      if ((await listMembers(db, accountId)).some((m) => m.email === input.email && m.role === "admin")) {
        return reply.code(409).send({ error: `${input.email} is already an admin there` });
      }
      return reply.code(201).send((await createInvitation(db, { accountId, email: input.email, role: "admin" })) satisfies CreatedInvitation);
    });

    app.get("/operator/users", { config: operator }, async () => (await listUserOverviews(db)) satisfies UserOverview[]);

    // A one-time link to choose a new password and authenticator. Earlier links stop working; the old sign-in keeps working until the link is used.
    app.post("/operator/users/:id/reset", { config: operator }, async (req, reply) => {
      const reset = await createSignInReset(db, id.parse(req.params).id);
      return reset ? reply.code(201).send(reset satisfies CreatedReset) : reply.code(404).send({ error: "User not found" });
    });
  };
}
