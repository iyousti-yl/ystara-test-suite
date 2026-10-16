import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectionSecretContext, secretBox } from "./secrets.js";

// Sealing and MASTER_KEY themselves are tested with sign-in (apps/api/src/auth/auth.test.ts).
describe("a secret sealed for one row", () => {
  const box = secretBox(randomBytes(32));
  const tenantA = connectionSecretContext("00000000-0000-4000-8000-00000000000a");
  const tenantB = connectionSecretContext("00000000-0000-4000-8000-00000000000b");

  it("opens only with the same context, so it can't be copied to another tenant's row", () => {
    const sealed = box.seal("synthetic-secret", tenantA);
    expect(box.open(sealed, tenantA)).toBe("synthetic-secret");
    expect(() => box.open(sealed, tenantB)).toThrow();
    expect(() => box.open(sealed)).toThrow();
  });

  it("without a context, works as before", () => {
    const sealed = box.seal("JBSWY3DPEHPK3PXP");
    expect(box.open(sealed)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => box.open(sealed, tenantA)).toThrow();
  });

  it("refuses a shortened authentication tag", () => {
    const [v, iv, tag, ct] = box.seal("synthetic-secret", tenantA).split(".");
    const short = Buffer.from(tag, "base64url").subarray(0, 12).toString("base64url");
    expect(() => box.open([v, iv, short, ct].join("."), tenantA)).toThrow();
  });
});
