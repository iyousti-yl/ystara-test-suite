import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  acceptInvitation,
  createSession,
  deleteSession,
  findOpenInvitation,
  findSession,
  findUserByEmail,
  getUser,
  membershipsOf,
  recordFailedCode,
  switchSessionAccount,
  useTotpStep,
  type Db,
  type Session,
} from "@ystara/db";
import { ROLE_PERMISSIONS, type AuthenticatorSetup, type InvitationOffer, type Me } from "@ystara/shared";
import { clearSessionCookie, PENDING_MINUTES, SESSION_MINUTES, setSessionCookie, signedIn } from "../auth/access.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/passwords.js";
import type { SecretBox } from "../auth/secrets.js";
import { matchTotp, newTotpSecret, otpauthUri } from "../auth/totp.js";

/**
 * Signing in, and joining an account through an invitation link, under /api.
 *
 * Signing in takes two steps: email and password start a short "pending"
 * session; the code from the authenticator app turns it into a real one (a
 * new token, so a token seen before the code is worthless after it).
 * There is no sign-up: users only arrive through invitations, which an
 * account admin (or `npm run account:create`) creates.
 */
const email = z.string().trim().toLowerCase().email().max(254);
const code = z.string().trim().max(10);
const Login = z.object({ email, password: z.string().min(1).max(1000) });
const Code = z.object({ code });
const SwitchAccount = z.object({ accountId: z.string().uuid() });
const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/) });
const NewUser = z.object({ password: z.string().max(1000), totpSecret: z.string().regex(/^[A-Z2-7]{32}$/), code });

/** Wrong codes allowed before the password has to be typed again. */
const MAX_FAILED_CODES = 5;
/** Ten tries a minute per address on everything that checks a password, code or link. */
const limited = { rateLimit: { max: 10, timeWindow: "1 minute" } };

const INVITATION_GONE = "This invitation link is no longer valid. Ask your admin for a new one.";

export function authRoutes(db: Db, secrets: SecretBox) {
  // An unknown email is checked against this hash, so it takes as long as a wrong password and
  // the answer time doesn't tell which emails have a user.
  let dummy: Promise<string> | undefined;
  const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

  /** Ends whatever session the browser had and starts a new one. */
  async function startSession(req: FastifyRequest, reply: FastifyReply, input: { userId: string; accountId: string; verified: boolean }) {
    if (req.sessionToken) await deleteSession(db, req.sessionToken);
    const minutes = input.verified ? SESSION_MINUTES : PENDING_MINUTES;
    const token = await createSession(db, { ...input, minutes });
    setSessionCookie(reply, token, minutes);
    return token;
  }

  return async (app: FastifyInstance) => {
    app.post("/auth/login", { config: { access: "public", ...limited } }, async (req, reply) => {
      const input = Login.parse(req.body);
      const user = await findUserByEmail(db, input.email);
      const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));
      if (!user || !ok) return reply.code(401).send({ error: "The email or password is not right" });
      const [account] = await membershipsOf(db, user.id);
      if (!account) return reply.code(403).send({ error: "You are no longer a member of any account. Ask an admin to invite you again." });
      await startSession(req, reply, { userId: user.id, accountId: account.id, verified: false });
      return { next: "code" };
    });

    app.post("/auth/code", { config: { access: "pending", ...limited } }, async (req, reply) => {
      const pending = req.pending!;
      const user = await getUser(db, pending.userId);
      const step = user && matchTotp(secrets.open(user.totpSecret), Code.parse(req.body).code);
      if (!user || step === undefined || !(await useTotpStep(db, user.id, step))) {
        if ((await recordFailedCode(db, req.sessionToken!)) >= MAX_FAILED_CODES) {
          await deleteSession(db, req.sessionToken!);
          clearSessionCookie(reply);
          return reply.code(401).send({ error: "Too many wrong codes. Sign in with your password again.", restart: true });
        }
        return reply.code(401).send({ error: "That code is not right, or was already used. Try the next one your app shows." });
      }
      const token = await startSession(req, reply, { userId: user.id, accountId: pending.accountId, verified: true });
      return me(db, (await findSession(db, token))!);
    });

    app.post("/auth/logout", { config: { access: "public" } }, async (req, reply) => {
      if (req.sessionToken) await deleteSession(db, req.sessionToken);
      clearSessionCookie(reply);
      return reply.code(204).send();
    });

    app.get("/auth/me", async (req) => me(db, signedIn(req)));

    /** Work in another account the user belongs to. */
    app.post("/auth/account", async (req, reply) => {
      const { accountId } = SwitchAccount.parse(req.body);
      if (!(await switchSessionAccount(db, req.sessionToken!, accountId))) return reply.code(404).send({ error: "You are not a member of that account" });
      return me(db, (await findSession(db, req.sessionToken!))!);
    });

    // --- Invitation links (/invite/<token> in the web app)

    app.get("/invitations/:token", { config: { access: "public", ...limited } }, async (req, reply) => {
      const invitation = await findOpenInvitation(db, Token.parse(req.params).token);
      if (!invitation) return reply.code(404).send({ error: INVITATION_GONE });
      const existingUser = (await findUserByEmail(db, invitation.email)) !== undefined;
      return { account: invitation.account.name, email: invitation.email, role: invitation.role, existingUser } satisfies InvitationOffer;
    });

    // A new secret for the authenticator app. Nothing is stored until the user accepts with a code from it.
    app.post("/invitations/:token/authenticator", { config: { access: "public", ...limited } }, async (req, reply) => {
      const invitation = await findOpenInvitation(db, Token.parse(req.params).token);
      if (!invitation) return reply.code(404).send({ error: INVITATION_GONE });
      if (await findUserByEmail(db, invitation.email)) return reply.code(409).send({ error: "This email already has a user: sign in instead" });
      const secret = newTotpSecret();
      return { secret, otpauthUri: otpauthUri(secret, invitation.email) } satisfies AuthenticatorSetup;
    });

    app.post("/invitations/:token/accept", { config: { access: "public", ...limited } }, async (req, reply) => {
      const { token } = Token.parse(req.params);
      const invitation = await findOpenInvitation(db, token);
      if (!invitation) return reply.code(404).send({ error: INVITATION_GONE });

      // Someone who already uses Ystara (in another account) joins by signing in as that email first.
      const existing = await findUserByEmail(db, invitation.email);
      if (existing) {
        if (req.auth?.userId !== existing.id) return reply.code(401).send({ error: `Sign in as ${invitation.email} first, then open the link again` });
        const joined = await acceptInvitation(db, token, { existingUserId: existing.id });
        if (!joined) return reply.code(404).send({ error: INVITATION_GONE });
        await switchSessionAccount(db, req.sessionToken!, joined.accountId);
        return me(db, (await findSession(db, req.sessionToken!))!);
      }

      // A new user chooses a password and proves the authenticator app works with one code.
      const input = NewUser.parse(req.body);
      const problem = passwordProblem(input.password);
      if (problem) return reply.code(400).send({ error: problem });
      const step = matchTotp(input.totpSecret, input.code);
      if (step === undefined) return reply.code(400).send({ error: "That code is not right. Check that the app shows Ystara and try the next code." });
      const joined = await acceptInvitation(db, token, {
        newUser: { passwordHash: await hashPassword(input.password), totpSecret: secrets.seal(input.totpSecret), totpStep: step },
      });
      if (!joined) return reply.code(404).send({ error: INVITATION_GONE });
      const session = await startSession(req, reply, { ...joined, verified: true });
      return reply.code(201).send(await me(db, (await findSession(db, session))!));
    });
  };
}

async function me(db: Db, session: Session): Promise<Me> {
  const accounts = await membershipsOf(db, session.userId);
  const current = accounts.find((a) => a.id === session.accountId)!;
  return {
    user: { id: session.userId, email: session.email },
    account: { id: current.id, name: current.name },
    role: session.role,
    permissions: ROLE_PERMISSIONS[session.role],
    accounts,
  };
}
