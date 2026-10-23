import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accountSpaces, changeMember, createInvitation, deleteInvitation, getAccountSettings, listInvitations, listMembers, renameAccount, setAccountSettings, type Db } from "@ystara/db";
import { ROLES, type AccountSettings, type CreatedInvitation, type Team } from "@ystara/shared";
import { signedIn } from "../auth/access.js";
import { spaceId } from "./discovery.js";

/**
 * An account's users and roles, under /api/team: the admin page in the web
 * app. Every route needs "users.manage" (admins), except renaming the account
 * and its settings under /api/account/settings ("account.manage", admins too),
 * and only touches the signed-in account. An
 * account always keeps at least one admin.
 *
 * A member other than an admin can be limited to some spaces (spaces: a list
 * of space IDs, null for every space); see SpaceScope in @ystara/shared.
 */
const manage = { access: "users.manage" } as const;
const role = z.enum(ROLES);
/** Null for every space, or at least one space ID. */
const spaces = z
  .array(spaceId)
  .min(1, "Pick at least one space, or every space")
  .max(100)
  .transform((s) => [...new Set(s)].sort())
  .nullable();
const NewInvitation = z.object({ email: z.string().trim().toLowerCase().email().max(254), role, spaces: spaces.default(null) });
const MemberChange = z.object({ role, spaces: spaces.optional() });
const AccountName = z.object({ name: z.string().trim().min(1).max(100) });
const Settings = z.object({ draftingWithClaude: z.boolean() }).strict();
const userId = z.object({ userId: z.string().uuid() });
const id = z.object({ id: z.string().uuid() });

const LAST_ADMIN = "An account needs at least one admin. Make someone else an admin first.";

export function teamRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    app.get("/team", { config: manage }, async (req) => {
      const { accountId } = signedIn(req);
      return { members: await listMembers(db, accountId), invitations: await listInvitations(db, accountId) } satisfies Team;
    });

    // The account's name, as its members and Ystara's operator see it. Names are unique: a taken one answers 409.
    app.patch("/team/account", { config: { access: "account.manage" } }, async (req) => {
      const me = signedIn(req);
      const account = (await renameAccount(db, me.accountId, AccountName.parse(req.body).name))!;
      req.log.info({ userId: me.userId, accountId: me.accountId }, "account renamed by its admin");
      return account;
    });

    // What the account allows: drafting scenarios with Claude, which sends pipeline definitions to Anthropic.
    app.get("/account/settings", { config: { access: "account.manage" } }, async (req) => (await getAccountSettings(db, signedIn(req).accountId))! satisfies AccountSettings);

    app.put("/account/settings", { config: { access: "account.manage" } }, async (req) => setAccountSettings(db, signedIn(req).accountId, Settings.parse(req.body)));

    app.post("/team/invitations", { config: manage }, async (req, reply) => {
      const { accountId } = signedIn(req);
      const input = NewInvitation.parse(req.body);
      if ((await listMembers(db, accountId)).some((m) => m.email === input.email)) {
        return reply.code(409).send({ error: `${input.email} is already a member. Change their role instead.` });
      }
      const created = await createInvitation(db, { accountId, ...input });
      return reply.code(201).send(created satisfies CreatedInvitation);
    });

    // The spaces the account's scans covered, to pick from when limiting a member. Any other space ID can be typed in.
    app.get("/team/spaces", { config: manage }, async (req) => accountSpaces(db, signedIn(req).accountId));

    app.delete("/team/invitations/:id", { config: manage }, async (req, reply) => {
      const deleted = await deleteInvitation(db, signedIn(req).accountId, id.parse(req.params).id);
      return deleted ? reply.code(204).send() : reply.code(404).send({ error: "Invitation not found" });
    });

    app.patch("/team/members/:userId", { config: manage }, async (req, reply) => {
      const change = MemberChange.parse(req.body);
      const result = await changeMember(db, signedIn(req).accountId, userId.parse(req.params).userId, change.role, change.spaces);
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
