import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createAccountWithAdmin, createSignInReset, inviteAdminWhereNoneLeft, listAccountOverviews, listUserOverviews, type Db } from "@ystara/db";
import type { AccountOverview, CreatedInvitation, CreatedReset, UserOverview } from "@ystara/shared";
import { signedIn } from "../auth/access.js";

/**
 * The operator panel, under /api/operator: every customer account and user,
 * for whoever runs Ystara (users.operator, set with `npm run operator:grant`).
 * It shows counts and memberships, never tenants, scans or pipelines, and it
 * can create an account with its first admin, invite an admin to an account
 * that has none left, and make a reset link for someone who lost their
 * password or phone. Each of these goes into the log with the operator's id,
 * and the account's admins see resets on their Users and roles page.
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
      const created = await createAccountWithAdmin(db, input.name, input.adminEmail);
      req.log.info({ operator: signedIn(req).userId, accountId: created.account.id }, "operator created an account and invited its first admin");
      return reply.code(201).send(created satisfies CreatedInvitation & { account: { id: string; name: string } });
    });

    // An admin for an account that has none left, e.g. when its only admin left the company.
    app.post("/operator/accounts/:id/invitations", { config: operator }, async (req, reply) => {
      const accountId = id.parse(req.params).id;
      const created = await inviteAdminWhereNoneLeft(db, accountId, AdminInvitation.parse(req.body).email);
      if (created === "not-found") return reply.code(404).send({ error: "Account not found" });
      if (created === "has-admin") return reply.code(409).send({ error: "This account still has an admin. Its admins invite new people on their Users and roles page." });
      if (created === "member") {
        return reply.code(409).send({ error: "This person is already a member of the account. An invitation can't change their role: invite someone who isn't a member yet." });
      }
      req.log.info({ operator: signedIn(req).userId, accountId, invitationId: created.invitation.id }, "operator invited an admin to an account without one");
      return reply.code(201).send(created satisfies CreatedInvitation);
    });

    app.get("/operator/users", { config: operator }, async () => (await listUserOverviews(db)) satisfies UserOverview[]);

    // A one-time link to choose a new password and authenticator. Earlier links stop working; the old sign-in keeps working until the link is used.
    app.post("/operator/users/:id/reset", { config: operator }, async (req, reply) => {
      const userId = id.parse(req.params).id;
      const reset = await createSignInReset(db, userId, signedIn(req).userId);
      if (reset === "not-found") return reply.code(404).send({ error: "User not found" });
      if (reset === "operator") return reply.code(409).send({ error: "This user is an operator. An operator's sign-in can't be reset from the panel." });
      req.log.info({ operator: signedIn(req).userId, userId }, "operator made a sign-in reset link");
      return reply.code(201).send(reset satisfies CreatedReset);
    });
  };
}
