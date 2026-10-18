import type { DatabaseUser, DatabaseUserCheck } from "@ystara/connector";
import { getDatabaseUser, getDatabaseUserLogin, getTenant, recordDatabaseCheck, type Db, type SpaceDatabaseUser } from "@ystara/db";
import { DATABASE_HOST_HINT, isDatabaseHost } from "@ystara/shared";
import { databaseUserSecretContext, type SecretBox } from "@ystara/shared/secrets";

/**
 * The database check job, after an admin enters or changes a space's database
 * user, or someone asks to check it again: sign in, make sure the user can't
 * change the space's schema, and store what it sees there (SELECT only, see
 * checkDatabaseUser in the connector). The pipeline pages show from that list
 * which steps a snapshot can measure.
 *
 * Tried once: a wrong password signed in again and again can lock the user. If
 * the user or password changed while this check ran, its verdict is dropped;
 * the new one has a check of its own.
 */
export async function runDatabaseCheck(
  db: Db,
  job: { tenantId: string; space: string },
  secrets: SecretBox,
  check: (user: DatabaseUser, space: string) => Promise<DatabaseUserCheck>,
): Promise<SpaceDatabaseUser | undefined> {
  const tenant = await getTenant(db, job.tenantId);
  const login = await getDatabaseUserLogin(db, job.tenantId, job.space);
  if (!tenant || !login) return undefined; // removed while queued

  try {
    // The API checks the host when it is entered; checked again here before the password goes anywhere.
    if (!isDatabaseHost(login.host)) throw new Error(`The host is not a Datasphere database host, so the password is not sent there. ${DATABASE_HOST_HINT}.`);
    const password = openPassword(secrets, login.sealedPassword, login.tenantId, login.space);
    const { visible } = await check({ host: login.host, user: login.user, password }, login.space);
    await recordDatabaseCheck(db, login, { visible });
  } catch (e) {
    await recordDatabaseCheck(db, login, { error: e instanceof Error ? e.message : String(e) });
  }
  return getDatabaseUser(db, job.tenantId, job.space);
}

/** The password in clear text, or an error that says what to do when this MASTER_KEY can't open it for this tenant and space. */
export function openPassword(secrets: SecretBox, sealed: string, tenantId: string, space: string): string {
  try {
    return secrets.open(sealed, databaseUserSecretContext(tenantId, space));
  } catch {
    throw new Error("The stored password can't be opened for this space with this worker's MASTER_KEY. An admin enters the database user again under Connection › Database users.");
  }
}
