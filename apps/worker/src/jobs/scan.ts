import { describeCliFailure, graphFromRaw, maskSecrets, readSpaces, type ObjectSource, type ScanOptions, type TechnicalClient } from "@ystara/connector";
import { getScan, getTenant, markScanFailed, markScanRunning, saveScanResult, type Db, type Scan, type Tenant } from "@ystara/db";

/**
 * The discovery scan job: read the scan's spaces from its tenant (list and
 * read only, through the connector), build the lineage graph and store both.
 *
 * Not retried on failure: almost every failure (expired login, missing rights,
 * wrong URL) needs a person, so the scan is marked failed with the reason.
 */

/** How one job reaches a tenant (tenant-login.ts), and how it tidies up afterwards. */
export interface TenantAccess {
  source: ObjectSource;
  /** The tenant's technical client, or the CLI login on the worker's machine: says what to check when nothing can be read. */
  login: "client" | "machine";
  /** The technical client it logs in with, so its secret is masked in every error and warning. */
  client?: Pick<TechnicalClient, "clientId" | "clientSecret">;
  close?(): Promise<void>;
}

const HINTS: Record<TenantAccess["login"], string> = {
  client: "Is the tenant's technical client a member of these spaces, with a role that may see their objects? Check again under Connection › Technical client to test its login.",
  machine: "Is the Datasphere CLI logged in on the machine the worker runs on, with read rights on these spaces? Or connect the tenant with a technical client.",
};

export async function runScan(
  db: Db,
  scanId: string,
  accessFor: (tenant: Tenant) => Promise<TenantAccess>,
  opts: ScanOptions = {},
): Promise<Scan | undefined> {
  const scan = await getScan(db, scanId);
  if (!scan) return undefined; // deleted while queued
  const tenant = await getTenant(db, scan.tenantId);
  if (!tenant) return undefined;

  await markScanRunning(db, scanId);
  let access: TenantAccess | undefined;
  try {
    access = await accessFor(tenant);
    const { raw, warnings: found } = await readSpaces(access.source, scan.spaces, opts);
    const { client } = access;
    const warnings = found.map((w) => maskSecrets(w, client)); // stored and shown, whether the scan succeeds or not
    if (raw.length === 0 && warnings.length > 0) {
      // Nothing could be listed or read at all, usually a login or missing rights.
      await markScanFailed(db, scanId, `Nothing could be read. ${HINTS[access.login]} First problem: ${warnings[0]}`, warnings);
      return getScan(db, scanId);
    }
    return await saveScanResult(db, scanId, raw, graphFromRaw(raw, scan.spaces, warnings));
  } catch (e) {
    await markScanFailed(db, scanId, describeCliFailure(e, access?.client));
    return getScan(db, scanId);
  } finally {
    await access?.close?.();
  }
}
