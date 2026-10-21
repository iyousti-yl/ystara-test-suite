import type { DatabaseUser } from "@ystara/connector";
import { finishScenarioSuite, getScenarioSuite, startScenarioSuite, suiteRunIds, type Db, type ScenarioSuite } from "@ystara/db";
import type { SecretBox } from "@ystara/shared/secrets";
import { openScenarioDatabase, runScenarioRun, type ScenarioDatabase } from "./scenario-run.js";

/**
 * The suite job: runs each scenario of the suite one after the other, by
 * name, as runScenarioRun runs one. They share one sign-in: the database user
 * signs in at the first check sent and once only, so a failed sign-in isn't
 * tried again for every scenario (that can lock the user). Each run compiles
 * on the tenant's latest successful scan when it starts.
 *
 * The suite passes when every run passed, fails otherwise, and is an error
 * when it couldn't run at all; its runs that never started are errors then.
 */
export async function runScenarioSuite(
  db: Db,
  suiteId: string,
  secrets: SecretBox,
  open: (user: DatabaseUser) => Promise<ScenarioDatabase> = openScenarioDatabase,
): Promise<ScenarioSuite | undefined> {
  const suite = await getScenarioSuite(db, suiteId);
  if (!suite) return undefined;
  if (!(await startScenarioSuite(db, suiteId))) return suite; // another worker has it

  const opened = new Map<string, Promise<ScenarioDatabase>>();
  const shared = async (user: DatabaseUser): Promise<ScenarioDatabase> => {
    const key = `${user.host}\n${user.user}`;
    if (!opened.has(key)) opened.set(key, open(user));
    const database = await opened.get(key)!;
    return { select: (query) => database.select(query), close: async () => undefined }; // closed once, below
  };
  try {
    const runs = await suiteRunIds(db, suiteId);
    if (!runs.length) await finishScenarioSuite(db, suiteId, "The pipeline has no scenarios");
    else {
      for (const runId of runs) await runScenarioRun(db, runId, secrets, shared);
      await finishScenarioSuite(db, suiteId);
    }
  } catch (e) {
    await finishScenarioSuite(db, suiteId, (e instanceof Error ? e.message : String(e)).split("\n")[0]);
  } finally {
    for (const database of opened.values()) await database.then((d) => d.close()).catch(() => undefined);
  }
  return getScenarioSuite(db, suiteId);
}
