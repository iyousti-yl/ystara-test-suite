import { randomBytes } from "node:crypto";
import { acceptInvitation, createAccount, createInvitation, createSession, findAccountByName, findUserByEmail, setOperator, type Db } from "@ystara/db";
import type { Role } from "@ystara/shared";
import { secretBox } from "@ystara/shared/secrets";
import { SESSION_COOKIE } from "./access.js";
import { hashPassword } from "./passwords.js";
import { newTotpSecret } from "./totp.js";

/**
 * Signed-in users for API tests, made straight in the database. Tests only:
 * a cheap password hash and a throwaway MASTER_KEY.
 */
export const testSecrets = secretBox(randomBytes(32));
export const TEST_PASSWORD = "correct horse battery";
const CHEAP = { N: 2 ** 10, r: 8, p: 1 };

export interface TestUser {
  userId: string;
  accountId: string;
  email: string;
  totpSecret: string;
  /** The Cookie header of a signed-in browser. */
  cookie: string;
}

/** A user with `role` in `account` (both created when missing), signed in there, limited to `spaces` when given; Ystara's operator when asked. */
export async function testUser(
  db: Db,
  input: { account: string; email: string; role: Role; spaces?: string[] | null; operator?: boolean },
): Promise<TestUser> {
  const account = (await findAccountByName(db, input.account)) ?? (await createAccount(db, input.account));
  const { token } = await createInvitation(db, { accountId: account.id, email: input.email, role: input.role, spaces: input.spaces ?? null });
  const existing = await findUserByEmail(db, input.email);
  const totpSecret = existing ? testSecrets.open(existing.totpSecret) : newTotpSecret();
  const joined = await acceptInvitation(
    db,
    token,
    existing
      ? { existingUserId: existing.id }
      : { newUser: { passwordHash: await hashPassword(TEST_PASSWORD, CHEAP), totpSecret: testSecrets.seal(totpSecret), totpStep: 0 } },
  );
  if (input.operator) await setOperator(db, input.email, true);
  const session = await createSession(db, { userId: joined!.userId, accountId: account.id, verified: true, minutes: 60 });
  return { userId: joined!.userId, accountId: account.id, email: input.email, totpSecret, cookie: `${SESSION_COOKIE}=${session}` };
}
