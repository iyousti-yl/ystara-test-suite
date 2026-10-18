import { describeCliFailure, type TechnicalClient } from "@ystara/connector";
import { getConnection, getConnectionLogin, getTenant, recordConnectionCheck, type ConnectionSpace, type Db, type TenantConnection } from "@ystara/db";
import type { SecretBox } from "@ystara/shared/secrets";
import { openSecret } from "../tenant-login.js";

/**
 * The connection check job, after an admin enters or changes a tenant's
 * technical client or its spaces, or someone asks to check again: log in with
 * the client and try to list the objects of each space the admin named (read
 * only). The Technical client page shows each space's result, and scans may use only
 * the readable ones.
 *
 * Connected when at least one space can be read. If the client or its spaces
 * changed while this check ran, its verdict is dropped; the new ones have a
 * check of their own.
 */
export async function runConnectionCheck(
  db: Db,
  tenantId: string,
  secrets: SecretBox,
  checkSpaces: (host: string, client: TechnicalClient, spaces: string[]) => Promise<ConnectionSpace[]>,
): Promise<TenantConnection | undefined> {
  const tenant = await getTenant(db, tenantId);
  const login = await getConnectionLogin(db, tenantId);
  if (!tenant || !login) return undefined; // removed while queued

  let client: TechnicalClient | undefined;
  try {
    if (!tenant.host) throw new Error("This tenant has no Datasphere URL; it only has imported scans.");
    client = { clientId: login.clientId, clientSecret: openSecret(secrets, login.sealedSecret, tenantId), tokenUrl: login.tokenUrl };
    await recordConnectionCheck(db, login, { spaces: await checkSpaces(tenant.host, client, login.spaces) });
  } catch (e) {
    await recordConnectionCheck(db, login, { error: describeCliFailure(e, client) });
  }
  return getConnection(db, tenantId);
}
