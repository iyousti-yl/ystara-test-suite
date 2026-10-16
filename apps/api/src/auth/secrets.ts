import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secrets the platform has to read back later (authenticator secrets now,
 * tenant credentials with the connection wizard) are stored encrypted with
 * MASTER_KEY: AES-256-GCM, which also detects any change to the stored text.
 * A copy of the database alone reveals none of them.
 *
 * Stored as v1.<iv>.<tag>.<ciphertext> (base64url), so the scheme can change later.
 */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function secretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), ct].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
    },
    open(sealed) {
      const [version, iv, tag, ct] = sealed.split(".");
      if (version !== "v1" || ct === undefined) throw new Error("Unknown secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

export const MASTER_KEY_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

/**
 * MASTER_KEY from the environment (.env.local): 32 random bytes in base64.
 * Refuses to start without one, rather than run with a weak or shared key.
 * Losing the key means every user sets up their authenticator again.
 */
export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const value = env.MASTER_KEY?.trim();
  const help = `Create one with\n  ${MASTER_KEY_COMMAND}\nand put it in .env.local as MASTER_KEY=<the output>. Keep it secret and keep a copy: losing it means every user sets up their authenticator again.`;
  if (!value) throw new Error(`MASTER_KEY is not set. ${help}`);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new Error(`MASTER_KEY is not 32 bytes in base64. ${help}`);
  if (new Set(key).size < 8) throw new Error(`MASTER_KEY looks like a placeholder, not random bytes. ${help}`);
  return key;
}
