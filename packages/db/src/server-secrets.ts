import type { Queryable } from "./db.js";

/**
 * Secrets of the server itself, entered by its operator (migration 012): for
 * now the Anthropic API key drafting uses. As everywhere, the value arrives
 * here already sealed with MASTER_KEY and leaves sealed.
 */
export type ServerSecretName = "anthropic_api_key";

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
