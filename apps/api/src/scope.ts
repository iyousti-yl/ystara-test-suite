import type { FastifyRequest } from "fastify";
import { getPipeline, getScan, getScenario, getTenant, type Db } from "@ystara/db";
import { seesSpace, type PipelineDefinition, type Scan, type StoredScenario, type Tenant } from "@ystara/shared";
import { signedIn } from "./auth/access.js";

/**
 * What the signed-in user may reach, in one place, for every route: their own
 * account's tenants, scans, pipelines and scenarios, and of those only the
 * ones in the spaces they see (seesSpace in @ystara/shared). A pipeline belongs
 * to its output's space, and so does everything run on it. Anything else is
 * undefined, and the route answers 404 as if it didn't exist.
 */
export function scope(db: Db) {
  /** The tenant, when it belongs to the signed-in account. Tenants themselves are not limited by space. */
  async function tenant(req: FastifyRequest, tenantId: string): Promise<Tenant | undefined> {
    const found = await getTenant(db, tenantId);
    return found?.accountId === signedIn(req).accountId ? found : undefined;
  }

  /** The scan, when its tenant belongs to the signed-in account. Its objects are filtered by space where they are read. */
  async function scan(req: FastifyRequest, scanId: string): Promise<Scan | undefined> {
    const found = await getScan(db, scanId);
    return found && (await tenant(req, found.tenantId)) ? found : undefined;
  }

  /** The pipeline with its tenant, when the tenant belongs to the signed-in account and the user sees its output's space. */
  async function pipelineAndTenant(req: FastifyRequest, pipelineId: string): Promise<{ pipeline: PipelineDefinition; tenant: Tenant } | undefined> {
    const found = await getPipeline(db, pipelineId);
    if (!found || !space(req, found.output.space)) return undefined;
    const owner = await tenant(req, found.tenantId);
    return owner ? { pipeline: found, tenant: owner } : undefined;
  }

  async function pipeline(req: FastifyRequest, pipelineId: string): Promise<PipelineDefinition | undefined> {
    return (await pipelineAndTenant(req, pipelineId))?.pipeline;
  }

  async function scenario(req: FastifyRequest, scenarioId: string): Promise<StoredScenario | undefined> {
    const found = await getScenario(db, scenarioId);
    return found && (await pipeline(req, found.pipelineId)) ? found : undefined;
  }

  return { tenant, scan, pipeline, pipelineAndTenant, scenario };
}

/** Whether the signed-in user sees the space. */
export const space = (req: FastifyRequest, name: string): boolean => seesSpace(signedIn(req).spaces, name);

/** Whether the signed-in user sees every space: needed for what reaches across spaces (a tenant's scan schedule). */
export const allSpaces = (req: FastifyRequest): boolean => signedIn(req).spaces === null;
