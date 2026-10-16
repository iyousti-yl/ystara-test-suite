import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  acceptInvitation,
  claimCodeAttempt,
  createSession,
  deleteSession,
  findOpenInvitation,
  findOpenSignInReset,
  findSession,
  findUserByEmail,
  getUser,
  invitationTotpSecret,
  membershipsOf,
  setInvitationTotpSecret,
  setSignInResetTotpSecret,
  signInResetTotpSecret,
  switchSessionAccount,
  useSignInReset,
  useTotpStep,
  type Db,
  type Session,
} from "@ystara/db";
import { ROLE_PERMISSIONS, type AuthenticatorSetup, type InvitationOffer, type Me, type ResetOffer } from "@ystara/shared";
import { clearSessionCookie, PENDING_MINUTES, SESSION_MINUTES, setSessionCookie, signedIn } from "../auth/access.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/passwords.js";
import type { SecretBox } from "../auth/secrets.js";
import { matchTotp, newTotpSecret, otpauthUri } from "../auth/totp.js";

/**
 * Signing in, joining an account through an invitation link, and choosing a
 * new password and authenticator through a reset link, under /api.
 *
 * Signing in takes two steps: email and password start a short "pending"
 * session; the code from the authenticator app turns it into a real one (a
 * new token, so a token seen before the code is worthless after it).
 * There is no sign-up: users only arrive through invitations, which an
 * account admin (or `npm run account:create`) creates. Reset links come
 * from the operator panel (routes/operator.ts).
 */
const email = z.string().trim().toLowerCase().email().max(254);
const code = z.string().trim().max(10);
const Login = z.object({ email, password: z.string().min(1).max(1000) });
const Code = z.object({ code });
const SwitchAccount = z.object({ accountId: z.string().uuid() });
const Token = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/) });
/** A new password and a code from the authenticator app, to prove the secret the server made for the link works. */
const NewSignIn = z.object({ password: z.string().max(1000), code });

/**
 * Wrong authenticator codes in a row (counted per user, across sign-ins)
 * before codes are locked: 1 minute, then 2, 4, ... up to an hour. Each lock
 * also ends the sign-in, so the password has to be typed again.
 */
const CODE_LOCK = { lockAfter: 5, maxMinutes: 60 };

/**
 * Ten tries a minute on everything that checks a password, code or link,
 * counted per address AND per what is tried (an email, a user, a link). One
 * client hammering one email then can't block everyone else who shares its
 * address (an office, or everyone behind a proxy that isn't trusted: see
 * YSTARA_TRUST_PROXY in server.ts). Counted after the body is read, so the
 * email in it can be part of the key.
 */
const limitedBy = (what: (req: FastifyRequest) => string) => ({
  rateLimit: { max: 10, timeWindow: "1 minute", hook: "preHandler" as const, keyGenerator: (req: FastifyRequest) => `${req.ip}|${what(req)}` },
});
const byEmail = limitedBy((req) => String((req.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase());
const byPendingUser = limitedBy((req) => req.pending?.userId ?? "");
const byLink = limitedBy((req) => String((req.params as { token?: unknown }).token ?? ""));

const INVITATION_GONE = "This invitation link is no longer valid. Ask your admin for a new one.";
const RESET_GONE = "This link is no longer valid. Ask for a new one.";

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

  /** Ends the sign-in (the password is needed again) and says how long codes are locked. */
  async function tooManyCodes(req: FastifyRequest, reply: FastifyReply, until: Date) {
    await deleteSession(db, req.sessionToken!);
    clearSessionCookie(reply);
    const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
    return reply.code(429).send({ error: `Too many wrong codes. Wait ${minutes === 1 ? "a minute" : `${minutes} minutes`}, then sign in again.`, restart: true });
  }

  /**
   * A new secret for the authenticator app, made here and kept (sealed) on the link by `keep`: the browser
   * shows it once as a QR code and never sends it back, so nobody can choose their own. Opening the setup
   * again replaces it. Undefined when the link closed in the meantime.
   */
  async function authenticatorSetup(email: string, keep: (sealed: string) => Promise<boolean>): Promise<AuthenticatorSetup | undefined> {
    const secret = newTotpSecret();
    if (!(await keep(secrets.seal(secret)))) return undefined;
    return { secret, otpauthUri: otpauthUri(secret, email) };
  }

  /** Checks a new password and a code from the link's secret (sealed); the stored form of both, or why they are refused. */
  async function newSignIn(body: unknown, sealedSecret: string | undefined): Promise<{ problem: string } | { passwordHash: string; totpSecret: string; totpStep: number }> {
    const input = NewSignIn.parse(body);
    const problem = passwordProblem(input.password);
    if (problem) return { problem };
    if (!sealedSecret) return { problem: "Set up the authenticator app first: open the link again." };
    const step = matchTotp(secrets.open(sealedSecret), input.code);
    if (step === undefined) return { problem: "That code is not right. Check that the app shows Ystara and try the next code." };
    return { passwordHash: await hashPassword(input.password), totpSecret: sealedSecret, totpStep: step };
  }

  return async (app: FastifyInstance) => {
    app.post("/auth/login", { config: { access: "public", ...byEmail } }, async (req, reply) => {
      const input = Login.parse(req.body);
      const user = await findUserByEmail(db, input.email);
      const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));
      if (!user || !ok) return reply.code(401).send({ error: "The email or password is not right" });
      const [account] = await membershipsOf(db, user.id);
      if (!account) return reply.code(403).send({ error: "You are no longer a member of any account. Ask an admin to invite you again." });
      await startSession(req, reply, { userId: user.id, accountId: account.id, verified: false });
      return { next: "code" };
    });

    app.post("/auth/code", { config: { access: "pending", ...byPendingUser } }, async (req, reply) => {
      const pending = req.pending!;
      const user = await getUser(db, pending.userId);
      if (!user) return reply.code(401).send({ error: "Sign in with your password again.", restart: true });
      const { code } = Code.parse(req.body);
      // Each attempt is counted before its code is checked, in one statement with the lock check, so requests sent at
      // the same moment can't check more codes than CODE_LOCK allows. While locked, no code is even checked.
      const attempt = await claimCodeAttempt(db, user.id, CODE_LOCK);
      if (!attempt.allowed) return tooManyCodes(req, reply, attempt.lockedUntil ?? new Date());
      const step = matchTotp(secrets.open(user.totpSecret), code);
      if (step === undefined || !(await useTotpStep(db, user.id, step))) {
        if (attempt.lockedUntil) return tooManyCodes(req, reply, attempt.lockedUntil);
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

    app.get("/invitations/:token", { config: { access: "public", ...byLink } }, async (req, reply) => {
      const invitation = await findOpenInvitation(db, Token.parse(req.params).token);
      if (!invitation) return reply.code(404).send({ error: INVITATION_GONE });
      const existingUser = (await findUserByEmail(db, invitation.email)) !== undefined;
      return { account: invitation.account.name, email: invitation.email, role: invitation.role, existingUser } satisfies InvitationOffer;
    });

    app.post("/invitations/:token/authenticator", { config: { access: "public", ...byLink } }, async (req, reply) => {
      const { token } = Token.parse(req.params);
      const invitation = await findOpenInvitation(db, token);
      if (!invitation) return reply.code(404).send({ error: INVITATION_GONE });
      if (await findUserByEmail(db, invitation.email)) return reply.code(409).send({ error: "This email already has a user: sign in instead" });
      const setup = await authenticatorSetup(invitation.email, (sealed) => setInvitationTotpSecret(db, token, sealed));
      return setup ?? reply.code(404).send({ error: INVITATION_GONE });
    });

    app.post("/invitations/:token/accept", { config: { access: "public", ...byLink } }, async (req, reply) => {
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
      const signIn = await newSignIn(req.body, await invitationTotpSecret(db, token));
      if ("problem" in signIn) return reply.code(400).send({ error: signIn.problem });
      const joined = await acceptInvitation(db, token, { newUser: signIn });
      if (!joined) return reply.code(404).send({ error: INVITATION_GONE });
      const session = await startSession(req, reply, { ...joined, verified: true });
      return reply.code(201).send(await me(db, (await findSession(db, session))!));
    });

    // --- Reset links (/reset/<token> in the web app), made on the operator panel

    app.get("/resets/:token", { config: { access: "public", ...byLink } }, async (req, reply) => {
      const reset = await findOpenSignInReset(db, Token.parse(req.params).token);
      return reset ? ({ email: reset.email } satisfies ResetOffer) : reply.code(404).send({ error: RESET_GONE });
    });

    app.post("/resets/:token/authenticator", { config: { access: "public", ...byLink } }, async (req, reply) => {
      const { token } = Token.parse(req.params);
      const reset = await findOpenSignInReset(db, token);
      const setup = reset && (await authenticatorSetup(reset.email, (sealed) => setSignInResetTotpSecret(db, token, sealed)));
      return setup ?? reply.code(404).send({ error: RESET_GONE });
    });

    // The new password and authenticator replace the old ones, every other sign-in of the user ends, and this browser is signed in.
    app.post("/resets/:token/accept", { config: { access: "public", ...byLink } }, async (req, reply) => {
      const { token } = Token.parse(req.params);
      if (!(await findOpenSignInReset(db, token))) return reply.code(404).send({ error: RESET_GONE });
      const signIn = await newSignIn(req.body, await signInResetTotpSecret(db, token));
      if ("problem" in signIn) return reply.code(400).send({ error: signIn.problem });
      const userId = await useSignInReset(db, token, signIn);
      if (!userId) return reply.code(404).send({ error: RESET_GONE });
      req.log.info({ userId }, "sign-in reset link used: new password and authenticator");
      const [account] = await membershipsOf(db, userId);
      if (!account) return reply.code(403).send({ error: "Your sign-in is reset, but you are no longer a member of any account. Ask an admin to invite you again." });
      const session = await startSession(req, reply, { userId, accountId: account.id, verified: true });
      return me(db, (await findSession(db, session))!);
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
    operator: session.operator,
  };
}
