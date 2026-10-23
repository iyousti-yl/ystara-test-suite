import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { masterKeyFromEnv, secretBox } from "@ystara/shared/secrets";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords.js";
import { base32Decode, base32Encode, matchTotp, otpauthUri, totpCode, totpStep } from "./totp.js";

describe("authenticator codes", () => {
  // RFC 6238, appendix B: the SHA-1 secret "12345678901234567890", last 6 digits of the 8-digit values.
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("match the RFC's test values at %i seconds", (seconds, code) => {
    expect(totpCode(secret, totpStep(new Date(seconds * 1000)))).toBe(code);
  });

  it("accept the code before and after, for a phone clock that is a little off, but no further", () => {
    const at = new Date(1234567890 * 1000);
    const step = totpStep(at);
    expect(matchTotp(secret, totpCode(secret, step), at)).toBe(step);
    expect(matchTotp(secret, totpCode(secret, step - 1), at)).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), at)).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 2), at)).toBeUndefined();
    expect(matchTotp(secret, ` ${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)} `, at)).toBe(step);
    expect(matchTotp(secret, "abcdef", at)).toBeUndefined();
  });

  it("have a secret the apps can read, in base32 and in a QR link", () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI"); // RFC 4648 test vector, without padding
    expect(otpauthUri("JBSWY3DPEHPK3PXP", "a.b@example.com")).toBe(
      "otpauth://totp/Ystara%3Aa.b%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Ystara&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("passwords", () => {
  const cheap = { N: 2 ** 10, r: 8, p: 1 };

  it("are stored as salted scrypt hashes and checked against them", async () => {
    const hash = await hashPassword("a long enough password", cheap);
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain("a long enough password");
    expect(await hashPassword("a long enough password", cheap)).not.toBe(hash);
    expect(await verifyPassword("a long enough password", hash)).toBe(true);
    expect(await verifyPassword("a long enough passworD", hash)).toBe(false);
    expect(await verifyPassword("anything", "not a hash")).toBe(false);
  });

  it("are the same whichever way an accented letter was typed", async () => {
    const hash = await hashPassword("café au lait, s'il vous plaît", cheap);
    expect(await verifyPassword("café au lait, s'il vous plaît", hash)).toBe(true);
  });

  it("need twelve characters", () => {
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem(" twelve chars ok")).toMatch(/spaces/);
    expect(passwordProblem("twelve chars")).toBeUndefined();
  });

  it("refuse the guesses that come first: one character over and over, or the user's email", () => {
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).toBe("Use more different characters");
    expect(passwordProblem("abababababababab")).toBe("Use more different characters");
    expect(passwordProblem("Jane.Doe@example.com", "jane.doe@example.com")).toBe("Don't use your email address in your password");
    expect(passwordProblem("my jane.doe password", "jane.doe@example.com")).toBe("Don't use your email address in your password");
    expect(passwordProblem("a long passphrase ok", "jo@example.com")).toBeUndefined(); // a name shorter than 4 is too common to refuse
  });
});

describe("stored secrets", () => {
  const box = secretBox(randomBytes(32));

  it("are encrypted, and any change to them is detected", () => {
    const sealed = box.seal("JBSWY3DPEHPK3PXP");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(box.open(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const [v, iv, tag, ct] = sealed.split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => box.open([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
    expect(() => secretBox(randomBytes(32)).open(sealed)).toThrow();
  });

  it("need a real MASTER_KEY, and say how to make one", () => {
    const key = randomBytes(32).toString("base64");
    expect(masterKeyFromEnv({ MASTER_KEY: key })).toEqual(Buffer.from(key, "base64"));
    expect(() => masterKeyFromEnv({})).toThrow(/not set.*randomBytes\(32\).*\.master-key/s);
    expect(() => masterKeyFromEnv({ MASTER_KEY: "change-me" })).toThrow(/not 32 bytes/);
    expect(() => masterKeyFromEnv({ MASTER_KEY: Buffer.alloc(32).toString("base64") })).toThrow(/placeholder/);
  });

  it("read MASTER_KEY from its file, and refuse two different keys without showing either", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ystara-key-"));
    try {
      const key = randomBytes(32).toString("base64");
      const file = path.join(dir, ".master-key");
      writeFileSync(file, `\uFEFF${key}\r\n`);
      expect(masterKeyFromEnv({ MASTER_KEY_FILE: file })).toEqual(Buffer.from(key, "base64"));
      expect(masterKeyFromEnv({ MASTER_KEY_FILE: file, MASTER_KEY: key })).toEqual(Buffer.from(key, "base64"));

      const other = randomBytes(32).toString("base64");
      expect(() => masterKeyFromEnv({ MASTER_KEY_FILE: file, MASTER_KEY: other })).toThrow(/different keys/);
      try {
        masterKeyFromEnv({ MASTER_KEY_FILE: file, MASTER_KEY: other });
      } catch (e) {
        expect(String(e)).not.toContain(key);
        expect(String(e)).not.toContain(other);
      }
      expect(() => masterKeyFromEnv({ MASTER_KEY_FILE: path.join(dir, "missing") })).toThrow(/doesn't exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuse a shortened authentication tag", () => {
    const box = secretBox(randomBytes(32));
    const [v, iv, tag, ct] = box.seal("JBSWY3DPEHPK3PXP").split(".");
    const short = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(() => box.open([v, iv, short, ct].join("."))).toThrow();
  });
});
