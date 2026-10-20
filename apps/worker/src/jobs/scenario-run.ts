import { buildPipeline, planScenario, runScenario, SqlReader, stepNotes, type DatabaseUser, type Fragment, type Row } from "@ystara/connector";
import { finishScenarioRun, getDatabaseUserLogin, getPipeline, getScenarioRun, getTenant, latestSucceededScan, listDatabaseUsers, loadGraph, startScenarioRun, type Db, type ScenarioRun } from "@ystara/db";
import { scenarioDatabaseUser, whyNoScenarioRun, type ScenarioCheckResult } from "@ystara/shared";
import type { SecretBox } from "@ystara/shared/secrets";
import { openPassword } from "./database-check.js";

/** A signed-in database user that sends a scenario's checks. */
export interface ScenarioDatabase {
  select(query: Fragment): Promise<Row[]>;
  close(): Promise<void>;
}

/** The real one: SQL through hdb, SELECT only (SqlReader in the connector). */
export async function openScenarioDatabase(user: DatabaseUser): Promise<ScenarioDatabase> {
  const sql = await SqlReader.connect(user);
  return { select: (query) => sql.select(query.sql, query.params), close: () => sql.close() };
}

/**
 * The scenario run job: compile the scenario as the run keeps it on the
 * tenant's latest successful scan, then send each check as one SELECT that
 * reads only the scenario's own rows (and DUMMY), and store what each gave
 * back. Any connected database user of the tenant can send them, since they
 * read nothing of its spaces; the output space's is taken when it has one.
 *
 * The run is an error when it can't start (no scan, problems in the scenario,
 * no database user, signing in failed), passed when every check passed, and
 * failed otherwise. The user signs in once, and only when a check is sent.
 */
export async function runScenarioRun(
  db: Db,
  runId: string,
  secrets: SecretBox,
  open: (user: DatabaseUser) => Promise<ScenarioDatabase> = openScenarioDatabase,
): Promise<ScenarioRun | undefined> {
  const run = await getScenarioRun(db, runId);
  if (!run) return undefined;
  const scan = await latestSucceededScan(db, run.tenantId);
  if (!(await startScenarioRun(db, runId, scan?.id ?? null))) return run; // another worker has it

  let database: Promise<ScenarioDatabase> | undefined;
  try {
    const pipeline = await getPipeline(db, run.pipelineId);
    if (!pipeline) throw new Error("The pipeline was deleted");
    if (!scan) throw new Error("This tenant has no successful scan yet");
    const graph = await loadGraph(db, scan.id, { definitions: true });
    const { space, technicalName } = pipeline.output;
    if (!graph.nodes.some((n) => n.space === space && n.technicalName === technicalName)) throw new Error(`${space}.${technicalName} is not in the latest scan`);
    const plan = planScenario(graph, buildPipeline(graph, pipeline.output, { excludeWriters: pipeline.excludeWriters }), run.spec);
    const steps = stepNotes(plan.simulation);
    if (plan.problems.length) {
      await finishScenarioRun(db, runId, { status: "error", error: `The scenario can't run: ${plan.problems.join(" ")}`, steps });
      return getScenarioRun(db, runId);
    }

    const tenant = await getTenant(db, run.tenantId);
    const users = await listDatabaseUsers(db, run.tenantId);
    const user = scenarioDatabaseUser(users, space);
    if (!user) throw new Error(whyNoScenarioRun(users, !!tenant?.host) ?? "The tenant has no connected database user");
    const login = (await getDatabaseUserLogin(db, run.tenantId, user.space))!;
    // Opened at the first check that is sent. A failed sign-in stays failed for the next checks: signing in again and again can lock the user.
    const select = async (query: Fragment) => {
      database ??= (async () => {
        const password = openPassword(secrets, login.sealedPassword, login.tenantId, login.space);
        return open({ host: login.host, user: login.user, password }).catch((e: unknown) => {
          throw new Error(`Signing in as ${login.user} failed: ${firstLine(e)}`);
        });
      })();
      return (await database).select(query);
    };

    const checks: ScenarioCheckResult[] = (await runScenario(plan, select)).map((c) => ({ checkpoint: c.checkpoint, label: c.label, status: c.status, detail: c.detail }));
    const signIn = database && (await database.then(() => undefined, (e: unknown) => firstLine(e)));
    if (signIn) await finishScenarioRun(db, runId, { status: "error", error: signIn, steps, checks });
    else await finishScenarioRun(db, runId, { status: checks.every((c) => c.status === "pass") ? "passed" : "failed", steps, checks });
  } catch (e) {
    await finishScenarioRun(db, runId, { status: "error", error: firstLine(e) });
  } finally {
    await database?.then((d) => d.close()).catch(() => undefined);
  }
  return getScenarioRun(db, runId);
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
