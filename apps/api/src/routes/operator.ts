import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createAccountWithAdmin,
  createSignInReset,
  deleteServerSecret,
  inviteAdminWhereNoneLeft,
  listAccountOverviews,
  listUserOverviews,
  renameAccount,
  serverSecretState,
  setServerSecret,
  type Db,
} from "@ystara/db";
import type { AccountOverview, ClaudeSetting, CreatedInvitation, CreatedReset, UserOverview } from "@ystara/shared";
import { serverSecretContext, type SecretBox } from "@ystara/shared/secrets";
import { signedIn } from "../auth/access.js";
import type { ClaudeAccess } from "../drafting.js";

/**
 * The operator panel, under /api/operator: every customer account and user,
 * for whoever runs Ystara (users.operator, set with `npm run operator:grant`).
 * It shows counts and memberships, never tenants, scans or pipelines, and it
 * can create or rename an account, invite an admin to an account
 * that has none left, and make a reset link for someone who lost their
 * password or phone. Each of these goes into the log with the operator's id,
 * and the account's admins see resets on their Users and roles page. It also
 * holds the server's Anthropic API key, for drafting scenarios with Claude:
 * checked with Anthropic before it is kept, sealed, and never shown again.
 */
const operator = { access: "operator" } as const;
const email = z.string().trim().toLowerCase().email().max(254);
const accountName = z.string().trim().min(1).max(100);
const NewAccount = z.object({ name: accountName, adminEmail: email });
const AccountRename = z.object({ name: accountName });
const AdminInvitation = z.object({ email });
const id = z.object({ id: z.string().uuid() });
const ClaudeKey = z.object({ apiKey: z.string().trim().min(20, "That is too short for an Anthropic API key").max(500) });

export function operatorRoutes(db: Db, secrets: SecretBox, claude: ClaudeAccess) {
  const claudeSetting = async (): Promise<ClaudeSetting> => {
    const operatorKey = (await serverSecretState(db, "anthropic_api_key")) ?? null;
    return { source: claude.fromEnvironment ? "environment" : operatorKey ? "operator" : null, operatorKey };
  };

  return async (app: FastifyInstance) => {
    app.get("/operator/accounts", { config: operator }, async () => (await listAccountOverviews(db)) satisfies AccountOverview[]);

    // The same as `npm run account:create`: the account and an invitation link for its first admin.
    app.post("/operator/accounts", { config: operator }, async (req, reply) => {
      const input = NewAccount.parse(req.body);
      const created = await createAccountWithAdmin(db, input.name, input.adminEmail);
      req.log.info({ operator: signedIn(req).userId, accountId: created.account.id }, "operator created an account and invited its first admin");
      return reply.code(201).send(created satisfies CreatedInvitation & { account: { id: string; name: string } });
    });

    // A customer's new name. Names are unique: a taken one answers 409.
    app.patch("/operator/accounts/:id", { config: operator }, async (req, reply) => {
      const accountId = id.parse(req.params).id;
      const account = await renameAccount(db, accountId, AccountRename.parse(req.body).name);
      if (!account) return reply.code(404).send({ error: "Account not found" });
      req.log.info({ operator: signedIn(req).userId, accountId }, "operator renamed an account");
      return account;
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

    app.get("/operator/claude", { config: operator }, claudeSetting);

    // A key is kept only once Anthropic has taken it, sealed with MASTER_KEY.
    app.put("/operator/claude", { config: operator }, async (req, reply) => {
      const { apiKey } = ClaudeKey.parse(req.body);
      let checked: "ok" | "refused";
      try {
        checked = await claude.check(apiKey);
      } catch (e) {
        req.log.warn(e, "checking an Anthropic API key failed");
        return reply.code(502).send({ error: "Anthropic couldn't be reached to check the key. Try again in a moment." });
      }
      if (checked === "refused") return reply.code(400).send({ error: "Anthropic doesn't accept this key. Copy it again from console.anthropic.com." });
      const sealed = secrets.seal(apiKey, serverSecretContext("anthropic_api_key"));
      await setServerSecret(db, { name: "anthropic_api_key", sealed, updatedBy: signedIn(req).userId });
      req.log.info({ operator: signedIn(req).userId }, "operator set the Anthropic API key");
      return claudeSetting();
    });

    app.delete("/operator/claude", { config: operator }, async (req, reply) => {
      if (await deleteServerSecret(db, "anthropic_api_key")) req.log.info({ operator: signedIn(req).userId }, "operator removed the Anthropic API key");
      return reply.code(204).send();
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
