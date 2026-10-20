import { refKey, type DspEdge, type DspObject, type EdgeKind, type LineageGraph, type ObjectDetails, type ObjectType, type Scan, type ScanSource, type ScanStatus } from "@ystara/shared";
import type { Db, Queryable } from "./db.js";

/**
 * Discovery scans (see the Scan type in @ystara/shared for the lifecycle).
 * The graph of a succeeded scan is stored as objects and edges; definitions
 * are stored once per tenant and hash.
 */
export type { Scan, ScanSource, ScanStatus };

/** One object as the CLI returned it. Same shape as the connector's RawObject. */
export interface StoredObject {
  space: string;
  kind: string;
  technicalName: string;
  businessName?: string;
  definition: unknown;
}

interface ScanRow {
  id: string;
  tenant_id: string;
  spaces: string[];
  source: ScanSource;
  status: ScanStatus;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  object_count: number | null;
  edge_count: number | null;
  warnings: string[];
  error: string | null;
}

const toScan = (r: ScanRow): Scan => ({
  id: r.id,
  tenantId: r.tenant_id,
  spaces: r.spaces,
  source: r.source,
  status: r.status,
  requestedAt: r.requested_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  objectCount: r.object_count,
  edgeCount: r.edge_count,
  warnings: r.warnings,
  error: r.error,
});

export async function createScan(db: Queryable, tenantId: string, spaces: string[], source: ScanSource = "tenant"): Promise<Scan> {
  const { rows } = await db.query<ScanRow>("insert into scans (tenant_id, spaces, source) values ($1, $2, $3) returning *", [tenantId, spaces, source]);
  return toScan(rows[0]);
}

export async function getScan(db: Queryable, id: string): Promise<Scan | undefined> {
  const { rows } = await db.query<ScanRow>("select * from scans where id = $1", [id]);
  return rows[0] && toScan(rows[0]);
}

export async function listScans(db: Queryable, tenantId: string): Promise<Scan[]> {
  return (await db.query<ScanRow>("select * from scans where tenant_id = $1 order by requested_at desc", [tenantId])).rows.map(toScan);
}

export async function latestSucceededScan(db: Queryable, tenantId: string): Promise<Scan | undefined> {
  const { rows } = await db.query<ScanRow>(
    "select * from scans where tenant_id = $1 and status = 'succeeded' order by finished_at desc limit 1",
    [tenantId],
  );
  return rows[0] && toScan(rows[0]);
}

export async function markScanRunning(db: Queryable, id: string): Promise<void> {
  await db.query("update scans set status = 'running', started_at = now(), error = null where id = $1", [id]);
}

export async function markScanFailed(db: Queryable, id: string, error: string, warnings: string[] = []): Promise<void> {
  await db.query("update scans set status = 'failed', finished_at = now(), error = $2, warnings = $3::jsonb where id = $1", [
    id,
    error,
    JSON.stringify(warnings),
  ]);
}

/**
 * Stores what a scan read and the graph built from it, then marks the scan
 * succeeded. All in one transaction, and safe to repeat for the same scan.
 */
export async function saveScanResult(db: Db, scanId: string, raw: StoredObject[], graph: LineageGraph): Promise<Scan> {
  const kindByKey = new Map(raw.map((r) => [refKey(r), r.kind]));
  return db.transaction(async (tx) => {
    const scan = await getScan(tx, scanId);
    if (!scan) throw new Error(`Scan ${scanId} does not exist.`);
    await tx.query("delete from scan_objects where scan_id = $1", [scanId]);
    await tx.query("delete from scan_edges where scan_id = $1", [scanId]);

    const definitions = new Map(graph.nodes.map((n) => [n.definitionHash, n.definition]));
    await insertRows(
      tx,
      "object_definitions (tenant_id, hash, definition)",
      [...definitions].map(([hash, definition]) => [scan.tenantId, hash, JSON.stringify(definition ?? null)]),
      ["", "", "::json"],
      // The same hash is the same definition, but one stored before migration 011 lost its key order.
      "on conflict (tenant_id, hash) do update set definition = excluded.definition",
    );
    await insertRows(
      tx,
      "scan_objects (scan_id, space, technical_name, type, cli_kind, business_name, definition_hash)",
      graph.nodes.map((n) => [scanId, n.space, n.technicalName, n.type, kindByKey.get(refKey(n)) ?? "unknown", n.businessName ?? null, n.definitionHash]),
    );
    await insertRows(
      tx,
      "scan_edges (scan_id, from_space, from_name, to_space, to_name, kind)",
      graph.edges.map((e) => [scanId, e.from.space, e.from.technicalName, e.to.space, e.to.technicalName, e.kind]),
      [],
      "on conflict do nothing",
    );

    const { rows } = await tx.query<ScanRow>(
      `update scans set status = 'succeeded', started_at = coalesce(started_at, now()), finished_at = now(),
         object_count = $2, edge_count = $3, warnings = $4::jsonb, error = null
       where id = $1 returning *`,
      [scanId, graph.nodes.length, graph.edges.length, JSON.stringify(graph.warnings)],
    );
    return toScan(rows[0]);
  });
}

/**
 * The lineage graph of a scan. Definitions are left out unless asked for:
 * pipelines and diagrams only need names, types and edges.
 */
export async function loadGraph(db: Queryable, scanId: string, opts: { definitions?: boolean } = {}): Promise<LineageGraph> {
  const scan = await getScan(db, scanId);
  if (!scan) throw new Error(`Scan ${scanId} does not exist.`);

  const { rows: objects } = await db.query<{
    space: string;
    technical_name: string;
    type: ObjectType;
    business_name: string | null;
    definition_hash: string;
    definition?: unknown;
  }>(
    `select o.space, o.technical_name, o.type, o.business_name, o.definition_hash${opts.definitions ? ", d.definition" : ""}
     from scan_objects o
     ${opts.definitions ? "join object_definitions d on d.tenant_id = $2 and d.hash = o.definition_hash" : ""}
     where o.scan_id = $1
     order by o.space, o.technical_name`,
    opts.definitions ? [scanId, scan.tenantId] : [scanId],
  );
  const nodes: DspObject[] = objects.map((o) => ({
    space: o.space,
    technicalName: o.technical_name,
    type: o.type,
    ...(o.business_name ? { businessName: o.business_name } : {}),
    definition: o.definition,
    definitionHash: o.definition_hash,
  }));

  const typeByKey = new Map(nodes.map((n) => [refKey(n), n.type]));
  const ref = (space: string, technicalName: string) => ({ space, technicalName, type: typeByKey.get(`${space}.${technicalName}`) ?? ("unknown" as const) });
  const { rows: edgeRows } = await db.query<{ from_space: string; from_name: string; to_space: string; to_name: string; kind: EdgeKind }>(
    "select from_space, from_name, to_space, to_name, kind from scan_edges where scan_id = $1 order by from_space, from_name, to_space, to_name, kind",
    [scanId],
  );
  const edges: DspEdge[] = edgeRows.map((e) => ({ from: ref(e.from_space, e.from_name), to: ref(e.to_space, e.to_name), kind: e.kind }));

  return { scannedAt: (scan.finishedAt ?? scan.requestedAt).toISOString(), spaces: scan.spaces, nodes, edges, warnings: scan.warnings };
}

/** One object of a scan with its definition and every edge that touches it, or undefined if the scan doesn't have it. */
export async function loadObject(db: Queryable, scanId: string, space: string, technicalName: string): Promise<ObjectDetails | undefined> {
  const { rows } = await db.query<{ type: ObjectType; business_name: string | null; definition_hash: string; definition: unknown }>(
    `select o.type, o.business_name, o.definition_hash, d.definition
     from scan_objects o
     join scans s on s.id = o.scan_id
     join object_definitions d on d.tenant_id = s.tenant_id and d.hash = o.definition_hash
     where o.scan_id = $1 and o.space = $2 and o.technical_name = $3`,
    [scanId, space, technicalName],
  );
  if (rows.length === 0) return undefined;
  const o = rows[0];
  const { rows: edgeRows } = await db.query<{
    from_space: string;
    from_name: string;
    from_type: ObjectType | null;
    to_space: string;
    to_name: string;
    to_type: ObjectType | null;
    kind: EdgeKind;
  }>(
    `select e.from_space, e.from_name, f.type as from_type, e.to_space, e.to_name, t.type as to_type, e.kind
     from scan_edges e
     left join scan_objects f on f.scan_id = e.scan_id and f.space = e.from_space and f.technical_name = e.from_name
     left join scan_objects t on t.scan_id = e.scan_id and t.space = e.to_space and t.technical_name = e.to_name
     where e.scan_id = $1 and ((e.from_space = $2 and e.from_name = $3) or (e.to_space = $2 and e.to_name = $3))
     order by e.kind, e.from_space, e.from_name, e.to_space, e.to_name`,
    [scanId, space, technicalName],
  );
  return {
    object: {
      space,
      technicalName,
      type: o.type,
      ...(o.business_name ? { businessName: o.business_name } : {}),
      definition: o.definition,
      definitionHash: o.definition_hash,
    },
    edges: edgeRows.map((e) => ({
      from: { space: e.from_space, technicalName: e.from_name, type: e.from_type ?? "unknown" },
      to: { space: e.to_space, technicalName: e.to_name, type: e.to_type ?? "unknown" },
      kind: e.kind,
    })),
  };
}

/** What a scan read, as the CLI returned it, so the graph can be rebuilt with a newer parser. */
export async function loadRaw(db: Queryable, scanId: string): Promise<StoredObject[]> {
  const { rows } = await db.query<{ space: string; cli_kind: string; technical_name: string; business_name: string | null; definition: unknown }>(
    `select o.space, o.cli_kind, o.technical_name, o.business_name, d.definition
     from scan_objects o
     join scans s on s.id = o.scan_id
     join object_definitions d on d.tenant_id = s.tenant_id and d.hash = o.definition_hash
     where o.scan_id = $1
     order by o.space, o.technical_name`,
    [scanId],
  );
  return rows.map((r) => ({
    space: r.space,
    kind: r.cli_kind,
    technicalName: r.technical_name,
    ...(r.business_name ? { businessName: r.business_name } : {}),
    definition: r.definition,
  }));
}

/** Multi-row insert in chunks, so a scan of thousands of objects is a handful of statements. */
async function insertRows(db: Queryable, target: string, rows: unknown[][], casts: string[] = [], suffix = ""): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const params: unknown[] = [];
    const values = chunk.map((row) => `(${row.map((v, i) => `$${params.push(v)}${casts[i] ?? ""}`).join(", ")})`);
    await db.query(`insert into ${target} values ${values.join(", ")} ${suffix}`, params);
  }
}
