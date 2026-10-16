import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatasphereCli, describeCliFailure, type TechnicalClient } from "@ystara/connector";
import { getConnectionLogin, type Db, type Tenant } from "@ystara/db";
import { DATASPHERE_URL_HINT, isDatasphereUrl, isTokenUrl, TOKEN_URL_HINT } from "@ystara/shared";
import { connectionSecretContext, type SecretBox } from "@ystara/shared/secrets";
import type { TenantAccess } from "./jobs/scan.js";

/**
 * How the worker logs in to a tenant: with its technical client (entered in
 * the Connect wizard). Each job gets a CLI in a new temporary folder that holds
 * the client's secrets file and token, and deletes that folder when it ends,
 * so nothing of one tenant's login outlives the job or meets another tenant.
 *
 * A tenant without a client is not scanned: the scan fails with "not
 * connected". Only a worker started with YSTARA_WORKER_MACHINE_LOGIN=1, for a
 * developer on their own computer, uses the CLI's own login on its machine
 * (`datasphere login`) instead. Never on a shared worker: every account's
 * tenants would be read with that person's rights.
 */
export interface LoginOptions {
  /** The Datasphere CLI. Default "datasphere". */
  bin?: string;
  /** Scan tenants without a client with this machine's own CLI login (YSTARA_WORKER_MACHINE_LOGIN=1). */
  machineLogin?: boolean;
}

/** The temporary CLI folders, named so a worker that starts can find the ones a killed worker left behind. */
const FOLDER_PREFIX = "ystara-tenant-";

/** A CLI logged in with `client`, its command list downloaded. `close` deletes its folder. */
export async function clientCli(host: string, client: TechnicalClient, bin?: string): Promise<{ cli: DatasphereCli; close: () => Promise<void> }> {
  checkUrls(host, client.tokenUrl);
  const configDir = await mkdtemp(path.join(tmpdir(), FOLDER_PREFIX));
  const close = () => rm(configDir, { recursive: true, force: true });
  try {
    const cli = new DatasphereCli({ host, bin, client, configDir });
    await cli.initCache();
    return { cli, close };
  } catch (e) {
    await close();
    throw new Error(`Logging in with the technical client failed:\n${describeCliFailure(e, client)}`);
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

/** For a scan: the tenant's technical client, or this machine's login when the worker was started for that. */
export async function tenantAccess(db: Db, secrets: SecretBox, tenant: Tenant, opts: LoginOptions = {}): Promise<TenantAccess> {
  if (!tenant.host) throw new Error(`Tenant "${tenant.name}" has no Datasphere URL; it only has imported scans.`);
  const login = await getConnectionLogin(db, tenant.id);
  if (!login) {
    if (!opts.machineLogin) throw new Error("This tenant is not connected: an admin connects it on the tenant page.");
    checkUrls(tenant.host);
    return { source: new DatasphereCli({ host: tenant.host, bin: opts.bin }), login: "machine" };
  }

  const client = { clientId: login.clientId, clientSecret: openSecret(secrets, login.sealedSecret, tenant.id), tokenUrl: login.tokenUrl };
  const { cli, close } = await clientCli(tenant.host, client, opts.bin);
  return { source: cli, login: "client", client, close };
}

/** The client's secret in clear text, or an error that says what to do when this MASTER_KEY can't open it for this tenant. */
export function openSecret(secrets: SecretBox, sealed: string, tenantId: string): string {
  try {
    return secrets.open(sealed, connectionSecretContext(tenantId));
  } catch {
    throw new Error("The stored client secret can't be opened for this tenant with this worker's MASTER_KEY. An admin enters the client again on the tenant page.");
  }
}

/**
 * The API checks both URLs when they are entered (@ystara/shared, urls.ts).
 * Checked again here before any login, for rows saved before that rule.
 */
function checkUrls(host: string, tokenUrl?: string): void {
  if (!isDatasphereUrl(host)) throw new Error(`Ystara only connects to SAP Datasphere tenants. This tenant's URL is not one: add the tenant again. ${DATASPHERE_URL_HINT}.`);
  if (tokenUrl !== undefined && !isTokenUrl(tokenUrl)) {
    throw new Error(`The client's token URL is not on SAP's sign-in service, so its secret is not sent there. An admin enters the client again on the tenant page. ${TOKEN_URL_HINT}.`);
  }
}

/** Longer than any job runs (a scan expires after 4 h), so the folder of a job still running on another worker is never touched. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Deletes the temporary CLI folders a worker left behind when it was killed in
 * the middle of a job: they still hold a client's secret and token. Run when
 * the worker starts. Returns how many it deleted.
 */
export async function removeStaleFolders(dir = tmpdir(), now = Date.now()): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(FOLDER_PREFIX)) continue;
    const folder = path.join(dir, entry.name);
    try {
      if (now - (await stat(folder)).mtimeMs < STALE_AFTER_MS) continue;
      await rm(folder, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or another user's: not ours to clean up.
    }
  }
  return removed;
}
