import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Secrets the platform has to read back later (each user's authenticator
 * secret, each tenant's technical client secret) are stored encrypted with
 * MASTER_KEY: AES-256-GCM, which also detects any change to the stored text.
 * A copy of the database alone reveals none of them. The API and the worker
 * both use it (Node only: import it as @ystara/shared/secrets, never from the web app).
 *
 * Stored as v1.<iv>.<tag>.<ciphertext> (base64url), so the scheme can change later.
 *
 * `context` ties a secret to the row it belongs to (AES-GCM additional data:
 * not stored, but checked when opening). A tenant's client secret is sealed
 * with connectionSecretContext(tenantId), so a sealed secret copied into
 * another tenant's row can't be opened there. Without a context, as for
 * authenticator secrets, nothing changes.
 */
export interface SecretBox {
  seal(plain: string, context?: string): string;
  open(sealed: string, context?: string): string;
}

/** The context a tenant's technical client secret is sealed and opened with. */
export const connectionSecretContext = (tenantId: string) => `tenant-connection:${tenantId}`;

const TAG_LENGTH = 16; // bytes; set on both sides, so a shortened tag is refused instead of checked with fewer bits

export function secretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes");
  return {
    seal(plain, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
      if (context !== undefined) cipher.setAAD(Buffer.from(context, "utf8"));
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), ct].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
    },
    open(sealed, context) {
      const [version, iv, tag, ct] = sealed.split(".");
      if (version !== "v1" || ct === undefined) throw new Error("Unknown secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      if (context !== undefined) decipher.setAAD(Buffer.from(context, "utf8"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/** Writes a new key to .master-key (never over an existing one), on Windows as on Linux and macOS. */
export const MASTER_KEY_COMMAND = `node -e "require('fs').writeFileSync('.master-key', require('crypto').randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 })"`;

/**
 * MASTER_KEY: 32 random bytes in base64, read from the file MASTER_KEY_FILE names. That is `.master-key`
 * at the repository root (git-ignored; loadLocalEnv points to it) or, in Docker Compose, a secret that
 * only the containers that need it get. A MASTER_KEY variable works too (a hosting platform's secret
 * store); if both are there, they must hold the same key.
 * Refuses to start without one, rather than run with a weak or shared key. Errors never show the key.
 * Losing the key means every user sets up their authenticator again, and every tenant's client secret is entered again.
 */
export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const help = `Create one in the repository root with\n  ${MASTER_KEY_COMMAND}\nIt writes .master-key, which git ignores. Keep it secret and keep a copy: losing it means every user sets up their authenticator again, and every tenant's client secret is entered again.`;
  const file = env.MASTER_KEY_FILE?.trim();
  if (file && !existsSync(file)) throw new Error(`MASTER_KEY_FILE names ${file}, which doesn't exist. ${help}`);
  // A BOM appears when an editor on Windows saves the file as "UTF-8 with BOM".
  const fromFile = file ? readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim() : undefined;
  const fromVariable = env.MASTER_KEY?.trim();
  if (fromFile && fromVariable && fromFile !== fromVariable) {
    throw new Error(`MASTER_KEY and the key file ${file} hold different keys. Keep one: the file, and remove MASTER_KEY from your settings.`);
  }
  const value = fromFile || fromVariable;
  if (!value) throw new Error(`MASTER_KEY is not set. ${help}`);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error(`MASTER_KEY is not 32 bytes in base64. ${help}`);
  if (new Set(key).size < 8) throw new Error(`MASTER_KEY looks like a placeholder, not random bytes. ${help}`);
  return key;
}
