import { useState } from "react";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError, useCode, useLogin } from "../api";
import { AuthForm, AuthFrame, Field, safeNext } from "../components/AuthFrame";
import { ErrorStrip } from "../components/Feedback";

/**
 * Signing in, in two steps: email and password, then the 6-digit code from
 * the authenticator app. /sign-in?next=/some/page returns there afterwards.
 */
export function SignInPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const login = useLogin();
  const verify = useCode();
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string>();

  const codeComplete = code.replace(/\s/g, "").length === 6;
  // A second Enter while a request is out sends nothing: the first answer decides (a second code would be refused after the first signed in).
  const submitPassword = () => {
    if (!email.trim() || !password || login.isPending) return;
    login.mutate(
      { email: email.trim(), password },
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
      onSuccess: () => navigate(safeNext(params.get("next")), { replace: true }),
      onError: (e) => {
        setCode("");
        // Too many wrong codes: the password step starts over.
        if (e instanceof ApiError && (e.body as { restart?: boolean } | undefined)?.restart) {
          setNotice(e.message);
          setPassword("");
          setStep("password");
          verify.reset();
        }
      },
    });
  };

  return (
    <AuthFrame title="Sign in">
      {/* A key per step, so the code field is a new field and doesn't keep the email typed before. */}
      {step === "password" ? (
        <AuthForm key="password" onSubmit={submitPassword}>
          {notice && (
            <MessageStrip design="Critical" hideCloseButton>
              {notice}
            </MessageStrip>
          )}
          <Field id="email" label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} />
          <Field id="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
          <ErrorStrip error={login.error} />
          <Button type="Submit" design="Emphasized" disabled={!email.trim() || !password || login.isPending}>
            Continue
          </Button>
        </AuthForm>
      ) : (
        <AuthForm key="code" onSubmit={submitCode}>
          <p>Enter the 6-digit code your authenticator app shows for Ystara ({email.trim().toLowerCase()}).</p>
          <Field id="code" label="Code" autoComplete="one-time-code" numeric value={code} onChange={setCode} placeholder="123456" />
          <ErrorStrip error={verify.error} />
          <Button type="Submit" design="Emphasized" disabled={!codeComplete || verify.isPending}>
            Sign in
          </Button>
          <Button
            design="Transparent"
            onClick={() => {
              setStep("password");
              setPassword("");
              verify.reset();
            }}
          >
            Use another account
          </Button>
        </AuthForm>
      )}
    </AuthFrame>
  );
}
