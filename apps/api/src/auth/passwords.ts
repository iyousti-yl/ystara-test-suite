import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { MIN_PASSWORD_LENGTH } from "@ystara/shared";

/**
 * Passwords are stored as scrypt hashes, never as text:
 *   scrypt$<N>$<r>$<p>$<salt>$<hash>   (salt and hash in base64)
 * The cost is stored with each hash, so it can be raised later without
 * breaking older ones. N = 2^17 takes about a third of a second and 128 MB,
 * which makes guessing a stolen hash slow (OWASP's scrypt guidance).
 */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}
export const SCRYPT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };

const KEY_LENGTH = 32;

/** Raises the memory cap so the cost above fits (Node's default is 32 MB). */
const options = ({ N, r, p }: ScryptCost): ScryptOptions => ({ N, r, p, maxmem: 256 * N * r });

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    // NFKC: the same password typed on another keyboard or system gives the same bytes.
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options(cost), (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, cost: ScryptCost = SCRYPT_COST): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, cost);
  return ["scrypt", cost.N, cost.r, cost.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Why a new password is refused, or undefined when it is fine. */
export function passwordProblem(password: string): string | undefined {
  if ([...password.normalize("NFKC")].length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.trim() !== password) return "Remove the spaces at the start or end";
  return undefined;
}
