import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The 6-digit codes of authenticator apps (Microsoft or Google Authenticator,
 * 1Password, ...): TOTP as in RFC 6238, with the settings every app supports
 * (HMAC-SHA1, 30-second steps, 6 digits). Small enough to own rather than add
 * a dependency; totp.test.ts checks it against the RFC's own test values.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;

/** A new shared secret: 20 random bytes, as base32 for the authenticator app. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** The time step a moment falls in (30-second steps since 1970). */
export const totpStep = (at: Date = new Date()): number => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/** The code for one time step (RFC 4226 HOTP with the step as counter). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The time step whose code matches `code`, allowing one step either way for
 * a phone clock that is a little off. Undefined when none matches.
 */
export function matchTotp(secret: string, code: string, at: Date = new Date()): number | undefined {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return undefined;
  const now = totpStep(at);
  return [now - 1, now, now + 1].find((step) => timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(typed)));
}

/** What the QR code holds: the authenticator app reads the account name, issuer and secret from it. */
export function otpauthUri(secret: string, email: string, issuer = "Ystara"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${query}`;
}

// --- Base32 (RFC 4648, no padding): how authenticator apps expect the secret.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("The secret is not valid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
