import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deleteConnection, getConnection, markConnectionChecking, setConnection, setConnectionSpaces, type Db, type Queryable } from "@ystara/db";
import { isTokenUrl, JOBS, TOKEN_URL_HINT, type ConnectionCheckJobData, type ConnectionState } from "@ystara/shared";
import { connectionSecretContext, type SecretBox } from "@ystara/shared/secrets";
import { signedIn } from "../auth/access.js";
import { allSpaces, scope, space } from "../scope.js";
import type { JobQueue } from "../server.js";
import { spaceIds } from "./discovery.js";

/**
 * A tenant's connection, under /api/tenants/:id/connection: the technical
 * OAuth client the worker logs in with, and the spaces it is meant to scan
 * (TenantConnection in @ystara/shared).
 *
 * Admins ("tenant.connect") enter, change and remove the client and its
 * spaces; anyone who can scan may ask for another check. Scans of the tenant
 * may then use only the spaces the last check could read (discovery.ts). The secret is sealed with MASTER_KEY
 * before it is stored and is never sent back, not even to admins: to change
 * it, they enter it again. It is sealed for this tenant only, so a sealed
 * secret copied into another tenant's row doesn't open. As with every route,
 * the API never calls Datasphere itself; the worker checks the client
 * (apps/worker/src/jobs/connection-check.ts).
 */

const ConnectionInput = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  // Only SAP's sign-in service, where App Integration's token URL points, so the secret is sent nowhere else (urls.ts in @ystara/shared).
  tokenUrl: z.string().trim().refine(isTokenUrl, TOKEN_URL_HINT),
  // Named by the admin: a client limited to its spaces can't list the tenant's spaces itself.
  spaces: spaceIds,
});
const SpacesInput = z.object({ spaces: spaceIds });
const id = z.object({ id: z.string().uuid() });

export function connectionRoutes(db: Db, queue: JobQueue, secrets: SecretBox) {
  /** The tenant, when it belongs to the signed-in account (scope.ts). */
  const tenants = scope(db);
  const ownTenant = (req: FastifyRequest) => tenants.tenant(req, id.parse(req.params).id);
  /** Saves with `save` and queues the check on the same transaction: a client marked "checking" always has its check coming. */
  const savedAndChecked = <T>(tenantId: string, save: (tx: Queryable) => Promise<T | undefined>) =>
    db.transaction(async (tx) => {
      const saved = await save(tx);
      if (saved) await queue.send(JOBS.connectionCheck, { tenantId } satisfies ConnectionCheckJobData, tx);
      return saved;
    });

  return async (app: FastifyInstance) => {
    app.get("/tenants/:id/connection", { config: { access: "pipelines.read" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const connection = (await getConnection(db, tenant.id)) ?? null;
      // A member limited to some spaces sees only theirs: another space's check can quote its objects' names.
      const visible = connection && !allSpaces(req) ? { ...connection, spaces: connection.spaces.filter((s) => space(req, s.space)) } : connection;
      return { connection: visible } satisfies ConnectionState;
    });

    // Enter or change the client and its spaces. It is checked at once, in the background.
    app.put("/tenants/:id/connection", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const input = ConnectionInput.parse(req.body);
      return savedAndChecked(tenant.id, (tx) =>
        setConnection(tx, {
          tenantId: tenant.id,
          clientId: input.clientId,
          sealedSecret: secrets.seal(input.clientSecret, connectionSecretContext(tenant.id)),
          tokenUrl: input.tokenUrl.replace(/\/$/, ""),
          spaces: input.spaces,
          updatedBy: signedIn(req).userId,
        }),
      );
    });

    // Change only the spaces, without entering the secret again. Checked at once, too.
    app.put("/tenants/:id/connection/spaces", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const { spaces } = SpacesInput.parse(req.body);
      const connection = await savedAndChecked(tenant.id, (tx) => setConnectionSpaces(tx, tenant.id, spaces, signedIn(req).userId));
      return connection ?? reply.code(404).send({ error: "This tenant has no technical client yet" });
    });

    app.post("/tenants/:id/connection/check", { config: { access: "discovery.run" } }, async (req, reply) => {
      const tenant = await ownTenant(req);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const connection = await savedAndChecked(tenant.id, (tx) => markConnectionChecking(tx, tenant.id));
      if (!connection) return reply.code(404).send({ error: "This tenant has no technical client yet" });
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
