import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { changeMember, createInvitation, deleteInvitation, listInvitations, listMembers, type Db } from "@ystara/db";
import { ROLES, type CreatedInvitation, type Team } from "@ystara/shared";
import { signedIn } from "../auth/access.js";

/**
 * An account's users and roles, under /api/team: the admin page in the web
 * app. Every route needs "users.manage" (admins) and only touches the
 * signed-in account. An account always keeps at least one admin.
 */
const manage = { access: "users.manage" } as const;
const role = z.enum(ROLES);
const NewInvitation = z.object({ email: z.string().trim().toLowerCase().email().max(254), role });
const RoleChange = z.object({ role });
const userId = z.object({ userId: z.string().uuid() });
const id = z.object({ id: z.string().uuid() });

const LAST_ADMIN = "An account needs at least one admin. Make someone else an admin first.";

export function teamRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    app.get("/team", { config: manage }, async (req) => {
      const { accountId } = signedIn(req);
      return { members: await listMembers(db, accountId), invitations: await listInvitations(db, accountId) } satisfies Team;
    });

    app.post("/team/invitations", { config: manage }, async (req, reply) => {
      const { accountId } = signedIn(req);
      const input = NewInvitation.parse(req.body);
      if ((await listMembers(db, accountId)).some((m) => m.email === input.email)) {
        return reply.code(409).send({ error: `${input.email} is already a member. Change their role instead.` });
      }
      const created = await createInvitation(db, { accountId, ...input });
      return reply.code(201).send(created satisfies CreatedInvitation);
    });

    app.delete("/team/invitations/:id", { config: manage }, async (req, reply) => {
      const deleted = await deleteInvitation(db, signedIn(req).accountId, id.parse(req.params).id);
      return deleted ? reply.code(204).send() : reply.code(404).send({ error: "Invitation not found" });
    });

    app.patch("/team/members/:userId", { config: manage }, async (req, reply) => {
      const result = await changeMember(db, signedIn(req).accountId, userId.parse(req.params).userId, RoleChange.parse(req.body).role);
      if (result === "not-found") return reply.code(404).send({ error: "Member not found" });
      if (result === "last-admin") return reply.code(409).send({ error: LAST_ADMIN });
      return reply.code(204).send();
    });

    // Removes the user from this account only; they keep any other account. Their sign-in here ends at once.
    app.delete("/team/members/:userId", { config: manage }, async (req, reply) => {
      const result = await changeMember(db, signedIn(req).accountId, userId.parse(req.params).userId, undefined);
      if (result === "not-found") return reply.code(404).send({ error: "Member not found" });
      if (result === "last-admin") return reply.code(409).send({ error: LAST_ADMIN });
      return reply.code(204).send();
    });
  };
}
