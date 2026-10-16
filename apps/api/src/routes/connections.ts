import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deleteConnection, getConnection, getTenant, markConnectionChecking, setConnection, type Db } from "@ystara/db";
import { JOBS, type ConnectionCheckJobData, type ConnectionState } from "@ystara/shared";
import type { SecretBox } from "@ystara/shared/secrets";
import { signedIn } from "../auth/access.js";
import type { JobQueue } from "../server.js";

/**
 * A tenant's connection, under /api/tenants/:id/connection: the technical
 * OAuth client the worker logs in with (TenantConnection in @ystara/shared).
 *
 * Admins ("tenant.connect") enter, change and remove the client; anyone who
 * can scan may ask for another check. The secret is sealed with MASTER_KEY
 * before it is stored and is never sent back, not even to admins: to change
 * it, they enter it again. As with every route, the API never calls
 * Datasphere itself; the worker checks the client (apps/worker/src/jobs/connection-check.ts).
 */

/**
 * Datasphere shows the token URL on the client's page in App Integration, on
 * SAP's sign-in service (hana.ondemand.com). Accepting no other host keeps the
 * worker from sending a client's secret anywhere else.
 */
const TOKEN_HOST = /\.hana\.ondemand\.com$/;

const ConnectionInput = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  tokenUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      const url = URL.canParse(value) ? new URL(value) : undefined; // zod runs this even when .url() failed
      return url?.protocol === "https:" && TOKEN_HOST.test(url.hostname) && url.pathname.replace(/\/$/, "") === "/oauth/token" && !url.search;
    }, "Use the token URL from the App Integration page: https://….hana.ondemand.com/oauth/token"),
});
const id = z.object({ id: z.string().uuid() });

export function connectionRoutes(db: Db, queue: JobQueue, secrets: SecretBox) {
  /** The tenant, when it belongs to the signed-in account (as in discovery.ts). */
  async function ownTenant(req: FastifyRequest) {
    const tenant = await getTenant(db, id.parse(req.params).id);
    return tenant?.accountId === signedIn(req).accountId ? tenant : undefined;
  }
  const check = (tenantId: string) => queue.send(JOBS.connectionCheck, { tenantId } satisfies ConnectionCheckJobData);

  return async (app: FastifyInstance) => {
    app.get("/tenants/:id/connection", { config: { access: "pipelines.read" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return { connection: (await getConnection(db, tenant.id)) ?? null } satisfies ConnectionState;
    });

    // Enter or change the client. It is checked at once, in the background.
    app.put("/tenants/:id/connection", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const input = ConnectionInput.parse(req.body);
      const connection = await setConnection(db, {
        tenantId: tenant.id,
        clientId: input.clientId,
        sealedSecret: secrets.seal(input.clientSecret),
        tokenUrl: input.tokenUrl.replace(/\/$/, ""),
        updatedBy: signedIn(req).userId,
      });
      await check(tenant.id);
      return connection;
    });

    app.post("/tenants/:id/connection/check", { config: { access: "discovery.run" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const connection = await markConnectionChecking(db, tenant.id);
      if (!connection) return reply.code(404).send({ error: "This tenant has no technical client yet" });
      await check(tenant.id);
      return reply.code(202).send(connection);
    });

    app.delete("/tenants/:id/connection", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!(await deleteConnection(db, tenant.id))) return reply.code(404).send({ error: "This tenant has no technical client" });
      return reply.code(204).send();
    });
  };
}
