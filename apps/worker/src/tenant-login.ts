import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatasphereCli, describeCliFailure, type TechnicalClient } from "@ystara/connector";
import { getConnectionLogin, type Db, type Tenant } from "@ystara/db";
import type { SecretBox } from "@ystara/shared/secrets";
import type { TenantAccess } from "./jobs/scan.js";

/**
 * How the worker logs in to a tenant. With a technical client (entered in the
 * Connect wizard), each job gets a CLI in a new temporary folder that holds
 * the client's secrets file and token, and deletes that folder when it ends,
 * so nothing of one tenant's login outlives the job or meets another tenant.
 * Without one, the CLI's own login on this machine (`datasphere login`), for
 * a developer running the worker on their own computer.
 */

/** A CLI logged in with `client`, its command list downloaded. `close` deletes its folder. */
export async function clientCli(host: string, client: TechnicalClient, bin?: string): Promise<{ cli: DatasphereCli; close: () => Promise<void> }> {
  const configDir = await mkdtemp(path.join(tmpdir(), "ystara-tenant-"));
  const close = () => rm(configDir, { recursive: true, force: true });
  try {
    const cli = new DatasphereCli({ host, bin, client, configDir });
    await cli.initCache();
    return { cli, close };
  } catch (e) {
    await close();
    throw new Error(`Logging in with the technical client failed:\n${describeCliFailure(e, [client.clientSecret])}`);
  }
}

/** The connection check: log in with `client` and list the spaces it can see. */
export async function listSpacesWith(host: string, client: TechnicalClient, bin?: string): Promise<string[]> {
  const { cli, close } = await clientCli(host, client, bin);
  try {
    return await cli.listSpaces();
  } finally {
    await close();
  }
}

/** For a scan: the tenant's technical client when it has one, otherwise this machine's login. */
export async function tenantAccess(db: Db, secrets: SecretBox, tenant: Tenant, bin?: string): Promise<TenantAccess> {
  if (!tenant.host) throw new Error(`Tenant "${tenant.name}" has no Datasphere URL; it only has imported scans.`);
  const login = await getConnectionLogin(db, tenant.id);
  if (!login) return { source: new DatasphereCli({ host: tenant.host, bin }), login: "machine", hide: [] };

  const clientSecret = openSecret(secrets, login.sealedSecret);
  const { cli, close } = await clientCli(tenant.host, { clientId: login.clientId, clientSecret, tokenUrl: login.tokenUrl }, bin);
  return { source: cli, login: "client", hide: [clientSecret], close };
}

/** The client's secret in clear text, or an error that says what to do when this MASTER_KEY can't open it. */
export function openSecret(secrets: SecretBox, sealed: string): string {
  try {
    return secrets.open(sealed);
  } catch {
    throw new Error("The stored client secret can't be opened with this worker's MASTER_KEY. An admin enters the client again on the tenant page.");
  }
}
