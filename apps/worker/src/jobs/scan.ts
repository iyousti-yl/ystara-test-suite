import { graphFromRaw, readSpaces, type ObjectSource, type ScanOptions } from "@ystara/connector";
import { getScan, getTenant, markScanFailed, markScanRunning, saveScanResult, type Db, type Scan, type Tenant } from "@ystara/db";

/**
 * The discovery scan job: read the scan's spaces from its tenant (list and
 * read only, through the connector), build the lineage graph and store both.
 *
 * Not retried on failure: almost every failure (expired login, missing rights,
 * wrong URL) needs a person, so the scan is marked failed with the reason.
 */
export async function runScan(
  db: Db,
  scanId: string,
  sourceFor: (tenant: Tenant) => ObjectSource,
  opts: ScanOptions = {},
): Promise<Scan | undefined> {
  const scan = await getScan(db, scanId);
  if (!scan) return undefined; // deleted while queued
  const tenant = await getTenant(db, scan.tenantId);
  if (!tenant) return undefined;

  await markScanRunning(db, scanId);
  try {
    const { raw, warnings } = await readSpaces(sourceFor(tenant), scan.spaces, opts);
    if (raw.length === 0 && warnings.length > 0) {
      // Nothing could be listed or read at all, usually an expired login or missing rights.
      const hint = "Is the Datasphere CLI logged in on the machine the worker runs on, with read rights on these spaces?";
      await markScanFailed(db, scanId, `Nothing could be read. ${hint} First problem: ${warnings[0]}`, warnings);
      return getScan(db, scanId);
    }
    return await saveScanResult(db, scanId, raw, graphFromRaw(raw, scan.spaces, warnings));
  } catch (e) {
    await markScanFailed(db, scanId, e instanceof Error ? e.message : String(e));
    return getScan(db, scanId);
  }
}
