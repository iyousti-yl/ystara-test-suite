import { describeCliFailure, type TechnicalClient } from "@ystara/connector";
import { getConnection, getConnectionLogin, getTenant, recordConnectionCheck, type Db, type TenantConnection } from "@ystara/db";
import type { SecretBox } from "@ystara/shared/secrets";
import { openSecret } from "../tenant-login.js";

/**
 * The connection check job, after an admin enters or changes a tenant's
 * technical client, or someone asks to check again: log in with the client
 * and list the spaces it can see (read only). The tenant page shows the
 * verdict and offers those spaces to scan.
 *
 * A client that logs in but sees no space counts as connected: the page then
 * says to add it to the spaces to scan. If the client changed while this
 * check ran, its verdict is dropped; the new client has a check of its own.
 */
export async function runConnectionCheck(
  db: Db,
  tenantId: string,
  secrets: SecretBox,
  listSpaces: (host: string, client: TechnicalClient) => Promise<string[]>,
): Promise<TenantConnection | undefined> {
  const tenant = await getTenant(db, tenantId);
  const login = await getConnectionLogin(db, tenantId);
  if (!tenant || !login) return undefined; // removed while queued

  let client: TechnicalClient | undefined;
  try {
    if (!tenant.host) throw new Error("This tenant has no Datasphere URL; it only has imported scans.");
    client = { clientId: login.clientId, clientSecret: openSecret(secrets, login.sealedSecret, tenantId), tokenUrl: login.tokenUrl };
    const spaces = await listSpaces(tenant.host, client);
    await recordConnectionCheck(db, login, { ok: true, spaces: [...new Set(spaces)].sort() });
  } catch (e) {
    await recordConnectionCheck(db, login, { ok: false, error: describeCliFailure(e, client) });
  }
  return getConnection(db, tenantId);
}
