import { serverSecretContext, type SecretBox } from "@ystara/shared/secrets";
import type { Queryable } from "./db.js";

/**
 * Secrets of the server itself (migration 012): the Anthropic API key drafting
 * uses, entered by the operator, and a known value sealed at the first start
 * (master_key_check), which shows at every start that MASTER_KEY is the key this
 * database's secrets were sealed with. As everywhere, a value arrives here
 * already sealed with MASTER_KEY and leaves sealed.
 */
export type ServerSecretName = "anthropic_api_key" | "master_key_check";

/** When a secret was last set and by whom (an email), never the secret. */
export interface ServerSecretState {
  updatedAt: Date;
  updatedBy: string | null;
}

/** The sealed value, when one is set. */
export async function getServerSecret(db: Queryable, name: ServerSecretName): Promise<string | undefined> {
  const { rows } = await db.query<{ sealed: string }>("select sealed from server_secrets where name = $1", [name]);
  return rows[0]?.sealed;
}

export async function serverSecretState(db: Queryable, name: ServerSecretName): Promise<ServerSecretState | undefined> {
  const { rows } = await db.query<{ updated_at: Date; email: string | null }>(
    "select s.updated_at, u.email from server_secrets s left join users u on u.id = s.updated_by where s.name = $1",
    [name],
  );
  return rows[0] && { updatedAt: rows[0].updated_at, updatedBy: rows[0].email };
}

export async function setServerSecret(db: Queryable, input: { name: ServerSecretName; sealed: string; updatedBy: string | null }): Promise<void> {
  await db.query(
    `insert into server_secrets (name, sealed, updated_by) values ($1, $2, $3)
     on conflict (name) do update set sealed = excluded.sealed, updated_by = excluded.updated_by, updated_at = now()`,
    [input.name, input.sealed, input.updatedBy],
  );
}

/** Whether there was one to remove. */
export async function deleteServerSecret(db: Queryable, name: ServerSecretName): Promise<boolean> {
  const { rows } = await db.query("delete from server_secrets where name = $1 returning name", [name]);
  return rows.length > 0;
}

const MASTER_KEY_CHECK = "ystara-master-key-check";

/**
 * Stops a program whose MASTER_KEY isn't the key this database's secrets were sealed with (a mistyped key after a
 * restore, a key from another server), before it starts: otherwise every sign-in code and every job that opens a
 * secret would fail later, one by one. The first program that starts on a database seals the check value.
 */
export async function assertMasterKey(db: Queryable, secrets: SecretBox): Promise<void> {
  const context = serverSecretContext("master_key_check");
  const { rows } = await db.query(
    "insert into server_secrets (name, sealed) values ('master_key_check', $1) on conflict (name) do nothing returning name",
    [secrets.seal(MASTER_KEY_CHECK, context)],
  );
  if (rows.length > 0) return;
  let opened: string | undefined;
  try {
    opened = secrets.open((await getServerSecret(db, "master_key_check"))!, context);
  } catch {
    // opened stays undefined: the key is not this database's
  }
  if (opened !== MASTER_KEY_CHECK) {
    throw new Error(
      "MASTER_KEY is not the key this database's secrets were sealed with, so they can't be opened. " +
        "Use the key file this database was made with (see the runbook in deploy/README.md), or check MASTER_KEY_FILE.",
    );
  }
}
