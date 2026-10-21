import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deleteTeamsChannel, getAccount, getTeamsChannel, getTeamsWebhook, setTeamsChannel, type Db } from "@ystara/db";
import { TEAMS_WEBHOOK_HINT, teamsWebhookHost, type PostToTeams, type TeamsChannel, type TeamsMessage } from "@ystara/shared";
import { teamsChannelSecretContext, type SecretBox } from "@ystara/shared/secrets";
import { signedIn } from "../auth/access.js";

/**
 * The account's Microsoft Teams channel, under /api/account/teams-channel:
 * alerts of scheduled snapshots and of scenarios that broke after a scan are
 * then also posted there (the worker's deliver.ts). An admin
 * ("account.manage") enters the address of a webhook made in Teams. The API
 * checks it is one of Microsoft's (teamsWebhookHost) and posts a test card
 * to it before keeping it; it is then sealed and never sent back, since
 * anyone who has it can post in the channel.
 */
const admin = { access: "account.manage" } as const;
const WebhookBody = z.object({ url: z.string().trim().min(1).max(2000) });
/** Each save or test posts to Teams: a few a minute per admin is plenty. */
const posting = { ...admin, rateLimit: { max: 6, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (req: FastifyRequest) => signedIn(req).userId } } as const;

export function teamsRoutes(db: Db, secrets: SecretBox, post: PostToTeams) {
  const testMessage = async (accountId: string): Promise<TeamsMessage> => {
    const account = await getAccount(db, accountId);
    return {
      title: "Ystara is connected to this channel",
      subtitle: `Account ${account?.name ?? ""}`.trim(),
      lines: ["Alerts of scheduled snapshots, and of scenarios that broke after a scan, will be posted here as well as emailed to each pipeline's watchers."],
    };
  };
  const channelOf = async (accountId: string): Promise<{ channel: TeamsChannel | null }> => ({ channel: (await getTeamsChannel(db, accountId)) ?? null });

  return async (app: FastifyInstance) => {
    app.get("/account/teams-channel", { config: admin }, async (req) => channelOf(signedIn(req).accountId));

    // Save the channel: refused (400) when the address isn't a Teams webhook, and (502) when the test post fails.
    app.put("/account/teams-channel", { config: posting }, async (req, reply) => {
      const { accountId, userId } = signedIn(req);
      const { url } = WebhookBody.parse(req.body);
      const host = teamsWebhookHost(url);
      if (!host) return reply.code(400).send({ error: `This isn't the address of a Teams webhook. ${TEAMS_WEBHOOK_HINT}` });
      try {
        await post(url, await testMessage(accountId));
      } catch (e) {
        return reply.code(502).send({ error: `${e instanceof Error ? e.message : String(e)} Nothing was saved.` });
      }
      await setTeamsChannel(db, { accountId, sealed: secrets.seal(url, teamsChannelSecretContext(accountId)), host, updatedBy: userId });
      req.log.info({ userId, accountId, host }, "Teams channel for alerts saved");
      return channelOf(accountId);
    });

    // Post the test card again, to the channel as it is saved.
    app.post("/account/teams-channel/test", { config: posting }, async (req, reply) => {
      const { accountId } = signedIn(req);
      const sealed = await getTeamsWebhook(db, accountId);
      if (!sealed) return reply.code(404).send({ error: "This account has no Teams channel" });
      try {
        await post(secrets.open(sealed, teamsChannelSecretContext(accountId)), await testMessage(accountId));
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
      }
      return reply.code(204).send();
    });

    app.delete("/account/teams-channel", { config: admin }, async (req, reply) => {
      const { accountId, userId } = signedIn(req);
      if (await deleteTeamsChannel(db, accountId)) req.log.info({ userId, accountId }, "Teams channel for alerts removed");
      return reply.code(204).send();
    });
  };
}
