import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { deleteDatabaseUser, getTenant, listDatabaseUsers, markDatabaseUserChecking, setDatabaseUser, type Db } from "@ystara/db";
import { DATABASE_HOST_HINT, databaseUserProblem, databaseUserSpace, isDatabaseHost, JOBS, type DatabaseCheckJobData } from "@ystara/shared";
import { databaseUserSecretContext, type SecretBox } from "@ystara/shared/secrets";
import { signedIn } from "../auth/access.js";
import type { JobQueue } from "../server.js";
import { spaceId } from "./discovery.js";

/**
 * A tenant's database users, under /api/tenants/:id/database-users: one per
 * space, which snapshots read the space's data with (SQL, read access only;
 * SpaceDatabaseUser in @ystara/shared).
 *
 * Admins ("tenant.connect") enter, change and remove them; anyone who can scan
 * may ask for another check. The space comes from the user name (SPACE#SUFFIX).
 * As for the technical client, the password is sealed with MASTER_KEY before it
 * is stored, for this tenant and space only, and never sent back. The API never
 * signs in itself: the worker checks the user (apps/worker/src/jobs/database-check.ts).
 */

const DatabaseUserInput = z.object({
  // The worker sends this host the password, so only SAP HANA Cloud (database-users.ts in @ystara/shared).
  host: z.string().trim().toLowerCase().refine(isDatabaseHost, DATABASE_HOST_HINT),
  user: z
    .string()
    .trim()
    .max(200)
    .refine((user) => !databaseUserProblem(user), "Database user names look like SPACE#SUFFIX")
    .refine((user) => spaceId.safeParse(databaseUserSpace(user)).success, "The part before # is the space ID: letters, digits and underscores"),
  password: z.string().trim().min(1).max(500),
});
const params = z.object({ id: z.string().uuid() });
const spaceParams = z.object({ id: z.string().uuid(), space: spaceId });

export function databaseUserRoutes(db: Db, queue: JobQueue, secrets: SecretBox) {
  /** The tenant, when it belongs to the signed-in account (as in discovery.ts). */
  async function ownTenant(req: FastifyRequest, tenantId: string) {
    const tenant = await getTenant(db, tenantId);
    return tenant?.accountId === signedIn(req).accountId ? tenant : undefined;
  }
  const check = (tenantId: string, space: string) => queue.send(JOBS.databaseCheck, { tenantId, space } satisfies DatabaseCheckJobData);

  return async (app: FastifyInstance) => {
    app.get("/tenants/:id/database-users", { config: { access: "pipelines.read" } }, async (req, reply) => {
      const tenant = await ownTenant(req, params.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      return listDatabaseUsers(db, tenant.id);
    });

    // Enter or change the database user of a space. It is checked at once, in the background.
    app.put("/tenants/:id/database-users", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const tenant = await ownTenant(req, params.parse(req.params).id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!tenant.host) return reply.code(409).send({ error: "This tenant has no Datasphere URL; it only has imported scans." });
      const input = DatabaseUserInput.parse(req.body);
      const space = databaseUserSpace(input.user);
      const user = await setDatabaseUser(db, {
        tenantId: tenant.id,
        space,
        host: input.host,
        user: input.user,
        sealedPassword: secrets.seal(input.password, databaseUserSecretContext(tenant.id, space)),
        updatedBy: signedIn(req).userId,
      });
      await check(tenant.id, space);
      return user;
    });

    app.post("/tenants/:id/database-users/:space/check", { config: { access: "discovery.run" } }, async (req, reply) => {
      const { id, space } = spaceParams.parse(req.params);
      const tenant = await ownTenant(req, id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      const user = await markDatabaseUserChecking(db, tenant.id, space);
      if (!user) return reply.code(404).send({ error: `Space ${space} has no database user` });
      await check(tenant.id, space);
      return reply.code(202).send(user);
    });

    app.delete("/tenants/:id/database-users/:space", { config: { access: "tenant.connect" } }, async (req, reply) => {
      const { id, space } = spaceParams.parse(req.params);
      const tenant = await ownTenant(req, id);
      if (!tenant) return reply.code(404).send({ error: "Tenant not found" });
      if (!(await deleteDatabaseUser(db, tenant.id, space))) return reply.code(404).send({ error: `Space ${space} has no database user` });
      return reply.code(204).send();
    });
  };
}
