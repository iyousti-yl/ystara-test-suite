import { useState } from "react";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import type { Me } from "@ystara/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { ApiError, ME, useCodeAgain, useLogin, useSignOut } from "../api";
import { useSignInEnded } from "../session";
import { AuthForm, Field } from "./AuthFrame";
import { Dialog } from "./Dialog";
import { ErrorStrip } from "./Feedback";

/**
 * "Your sign-in ended", over the page whose sign-in ended (session.ts), so
 * that what is on it (a scenario being built, a form in a dialog) isn't lost:
 * the password, then the code, right here. The same person carries on where
 * they were; anyone else starts at Home (useCodeAgain). Not on the sign-in
 * page, which is the same thing already.
 */
export function SignInAgain() {
  const ended = useSignInEnded();
  const client = useQueryClient();
  const { pathname } = useLocation();
  // Who was signed in: /auth/me keeps its last answer when a later one fails.
  const me = ended ? client.getQueryData<Me>(ME) : undefined;
  if (!me || pathname === "/sign-in") return null;
  return <SignInAgainDialog me={me} />;
}

function SignInAgainDialog({ me }: { me: Me }) {
  const navigate = useNavigate();
  const login = useLogin();
  const verify = useCodeAgain(() => navigate("/", { replace: true }));
  const signOut = useSignOut();
  const [step, setStep] = useState<"password" | "code">("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string>();
  const codeComplete = code.replace(/\s/g, "").length === 6;

  // A second Enter while a request is out sends nothing: the first answer decides.
  const submitPassword = () => {
    if (!password || login.isPending) return;
    login.mutate(
      { email: me.user.email, password, accountId: me.account.id },
      {
        onSuccess: () => {
          setNotice(undefined);
          setStep("code");
        },
      },
    );
  };
  const submitCode = () => {
    if (!codeComplete || verify.isPending || verify.isSuccess) return;
    verify.mutate(code.trim(), {
      onError: (e) => {
        setCode("");
        // Too many wrong codes: the password step starts over.
        if (e instanceof ApiError && (e.body as { restart?: boolean } | undefined)?.restart) {
          setNotice(e.message);
          setPassword("");
          setStep("password");
          login.reset();
          verify.reset();
        }
      },
    });
  };
  // To the sign-in page first: signing out empties the cache, and this dialog with it.
  const someoneElse = () => {
    navigate("/sign-in", { replace: true });
    signOut.mutate();
  };

  return (
    <Dialog
      headerText="Your sign-in ended"
      // Only signing in again, or signing out, closes it: the page behind can't do anything without a sign-in.
      onBeforeClose={(e) => e.preventDefault()}
      footer={
        <div className="dialog-footer">
          {step === "password" ? (
            <Button design="Emphasized" disabled={!password || login.isPending} onClick={submitPassword}>
              Continue
            </Button>
          ) : (
            <Button design="Emphasized" disabled={!codeComplete || verify.isPending} onClick={submitCode}>
              Sign in
            </Button>
          )}
          <Button design="Transparent" disabled={signOut.isPending} onClick={someoneElse}>
            Use another account
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>
          Ystara signs you out after an hour without use, or when you sign out elsewhere. Sign in again to carry on: nothing on this page is lost. If you had
          just clicked to save or start something, click it again once you are back.
        </p>
        {notice && (
          <MessageStrip design="Critical" hideCloseButton>
            {notice}
          </MessageStrip>
        )}
        {step === "password" ? (
          <AuthForm key="password" onSubmit={submitPassword}>
            <p>
              Sign in again as <b>{me.user.email}</b>.
            </p>
            {/* Tells a password manager whose password this is. */}
            <input type="email" autoComplete="username" value={me.user.email} readOnly hidden />
            <Field id="again-password" label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
            <ErrorStrip error={login.error} />
          </AuthForm>
        ) : (
          <AuthForm key="code" onSubmit={submitCode}>
            <p>Enter the 6-digit code your authenticator app shows for Ystara ({me.user.email}).</p>
            <Field id="again-code" label="Code" autoComplete="one-time-code" numeric value={code} onChange={setCode} placeholder="123456" />
            <ErrorStrip error={verify.error} />
          </AuthForm>
        )}
      </div>
    </Dialog>
  );
}
