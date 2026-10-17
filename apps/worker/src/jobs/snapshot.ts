import { randomBytes } from "node:crypto";
import { buildPipeline, measureObject, SqlReader, type DatabaseUser, type ObjectMeasures } from "@ystara/connector";
import {
  finishSnapshot,
  getDatabaseUserLogin,
  getPipeline,
  getSnapshot,
  latestSucceededScan,
  listDatabaseUsers,
  loadGraph,
  saveSnapshotObject,
  snapshotSalt,
  startSnapshot,
  type Db,
  type Snapshot,
} from "@ystara/db";
import { measurability, refKey, type SnapshotObject } from "@ystara/shared";
import { snapshotSaltContext, type SecretBox } from "@ystara/shared/secrets";
import { openPassword } from "./database-check.js";

/** A signed-in database user of one space, measuring with the tenant's salt. */
export interface SnapshotDatabase {
  measure(object: { name: string; type: "VIEW" | "TABLE" }): Promise<ObjectMeasures>;
  close(): Promise<void>;
}

/** The real one: SQL through hdb, SELECT only (measureObject in the connector). */
export async function openSnapshotDatabase(user: DatabaseUser, space: string, salt: string): Promise<SnapshotDatabase> {
  const sql = await SqlReader.connect(user);
  return { measure: (object) => measureObject(sql, space, object, salt), close: () => sql.close() };
}

/**
 * The snapshot job: measure every step of a saved pipeline that the database
 * user of its space can see, and store the measures (never rows; min, max and
 * small sums only as hashes made in the tenant's database). The steps come from
 * the tenant's latest successful scan, as on the pipeline page; each one is
 * stored with its definition's hash in that scan, and the ones that can't be
 * measured with the reason the pipeline page gives.
 *
 * Each space's user signs in once per snapshot. The snapshot fails when a
 * measurable step couldn't be measured, or when none could be; what was
 * measured is kept either way.
 */
export async function runSnapshot(
  db: Db,
  snapshotId: string,
  secrets: SecretBox,
  open: (user: DatabaseUser, space: string, salt: string) => Promise<SnapshotDatabase> = openSnapshotDatabase,
): Promise<Snapshot | undefined> {
  const snapshot = await getSnapshot(db, snapshotId);
  if (!snapshot) return undefined;
  const scan = await latestSucceededScan(db, snapshot.tenantId);
  if (!(await startSnapshot(db, snapshotId, scan?.id ?? null))) return snapshot; // another worker has it

  const databases = new Map<string, Promise<SnapshotDatabase>>();
  try {
    const pipeline = await getPipeline(db, snapshot.pipelineId);
    if (!pipeline) throw new Error("The pipeline was deleted");
    if (!scan) throw new Error("This tenant has no successful scan yet");
    const graph = await loadGraph(db, scan.id);
    const { space, technicalName } = pipeline.output;
    if (!graph.nodes.some((n) => n.space === space && n.technicalName === technicalName)) throw new Error(`${space}.${technicalName} is not in the latest scan`);
    const { steps } = buildPipeline(graph, pipeline.output, { excludeWriters: pipeline.excludeWriters });
    const users = await listDatabaseUsers(db, snapshot.tenantId);
    const definitionHashes = new Map(graph.nodes.map((n) => [refKey(n), n.definitionHash]));
    const salt = await openSalt(db, secrets, snapshot.tenantId);

    /** One sign-in per space, and only for a space with something to measure. */
    const database = (stepSpace: string) => {
      let opened = databases.get(stepSpace);
      if (!opened) {
        opened = (async () => {
          const login = (await getDatabaseUserLogin(db, snapshot.tenantId, stepSpace))!;
          const password = openPassword(secrets, login.sealedPassword, login.tenantId, login.space);
          return open({ host: login.host, user: login.user, password }, stepSpace, salt).catch((e: unknown) => {
            throw new Error(`Signing in as ${login.user} failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        })();
        databases.set(stepSpace, opened);
      }
      return opened;
    };

    let measured = 0;
    let failed = 0;
    for (const [position, step] of steps.entries()) {
      const result: SnapshotObject = {
        space: step.space,
        technicalName: step.technicalName,
        type: step.type,
        definitionHash: definitionHashes.get(refKey(step)) ?? null,
        status: "measured",
        reason: null,
        rows: null,
        columns: null,
        tookMs: null,
      };
      const reach = measurability(step, users);
      if (!reach.measurable) {
        await saveSnapshotObject(db, snapshotId, position, { ...result, status: "not_measurable", reason: reach.reason });
        continue;
      }
      const started = Date.now();
      try {
        const visible = users.find((u) => u.space === step.space)!.visible!.find((o) => o.name === step.technicalName)!;
        const measures = await (await database(step.space)).measure(visible);
        await saveSnapshotObject(db, snapshotId, position, { ...result, rows: measures.rows, columns: measures.columns, tookMs: Date.now() - started });
        measured++;
      } catch (e) {
        await saveSnapshotObject(db, snapshotId, position, { ...result, status: "failed", reason: firstLine(e), tookMs: Date.now() - started });
        failed++;
      }
    }

    if (failed) await finishSnapshot(db, snapshotId, { status: "failed", error: `${failed} of ${measured + failed} measurable steps couldn't be measured. Each one says why.` });
    else if (!measured) await finishSnapshot(db, snapshotId, { status: "failed", error: "None of this pipeline's steps can be measured with SQL. Each one says why." });
    else await finishSnapshot(db, snapshotId, { status: "succeeded" });
  } catch (e) {
    await finishSnapshot(db, snapshotId, { status: "failed", error: firstLine(e) });
  } finally {
    for (const opened of databases.values()) await opened.then((d) => d.close()).catch(() => undefined);
  }
  return getSnapshot(db, snapshotId);
}

/**
 * The tenant's salt in clear text (hex), made on its first snapshot. It never
 * changes: with another salt every hash would differ. If this MASTER_KEY can't
 * open it, the snapshot fails rather than start over with a new salt.
 */
async function openSalt(db: Db, secrets: SecretBox, tenantId: string): Promise<string> {
  const context = snapshotSaltContext(tenantId);
  const sealed = await snapshotSalt(db, tenantId, () => secrets.seal(randomBytes(32).toString("hex"), context));
  try {
    return secrets.open(sealed, context);
  } catch {
    throw new Error("The tenant's snapshot salt can't be opened with this worker's MASTER_KEY, so its hashes couldn't be compared with earlier snapshots.");
  }
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
