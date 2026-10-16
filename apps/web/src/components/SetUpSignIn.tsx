import { useEffect, useState, type ReactNode } from "react";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { MIN_PASSWORD_LENGTH, type AuthenticatorSetup } from "@ystara/shared";
import QRCode from "qrcode";
import { useNavigate } from "react-router";
import { AuthForm, AuthFrame, Field } from "./AuthFrame";
import { ErrorStrip } from "./Feedback";

/** What the browser sends: the password and a code. The authenticator secret stays on the server, which made it. */
export interface NewSignIn {
  password: string;
  code: string;
}

/**
 * Choosing a password, then setting up the authenticator app from a QR code
 * and proving it works with one code. Used by invitation links (a new user)
 * and reset links (a new password and phone); `setup` and `finish` are their
 * API calls.
 */
export function SetUpSignIn(props: {
  email: string;
  title: string;
  intro: ReactNode;
  setup: { mutate: () => void; data?: AuthenticatorSetup; error: Error | null; isPending: boolean };
  finish: { mutate: (input: NewSignIn, opts: { onSuccess: () => void }) => void; error: Error | null; isPending: boolean };
}) {
  const { setup, finish } = props;
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string>();

  const uri = setup.data?.otpauthUri;
  useEffect(() => {
    if (!uri) return;
    let current = true;
    void QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then((svg) => {
      if (current) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    });
    return () => {
      current = false;
    };
  }, [uri]);

  const tooShort = [...password.normalize("NFKC")].length < MIN_PASSWORD_LENGTH;
  const mismatch = repeat !== "" && repeat !== password;
  const passwordOk = !tooShort && repeat === password;
  const codeComplete = code.replace(/\s/g, "").length === 6;

  if (!setup.data) {
    return (
      <AuthFrame title={props.title}>
        {props.intro}
        <AuthForm key="password" onSubmit={() => passwordOk && setup.mutate()}>
          <p>Choose a password for {props.email}. Use at least {MIN_PASSWORD_LENGTH} characters; a few unrelated words work well.</p>
          {/* Tells a password manager which user the new password belongs to. */}
          <input type="email" autoComplete="username" value={props.email} readOnly hidden />
          <Field id="password" label="Password" type="password" autoComplete="new-password" value={password} onChange={setPassword} />
          <Field id="repeat" label="Password again" type="password" autoComplete="new-password" value={repeat} onChange={setRepeat} invalid={mismatch} />
          {mismatch && <span className="muted">The two passwords are not the same.</span>}
          <ErrorStrip error={setup.error} />
          <Button type="Submit" design="Emphasized" disabled={!passwordOk || setup.isPending}>
            Continue
          </Button>
        </AuthForm>
      </AuthFrame>
    );
  }

  const { secret } = setup.data;
  return (
    <AuthFrame title="Set up your authenticator app">
      <AuthForm
        key="authenticator"
        onSubmit={() => codeComplete && finish.mutate({ password, code: code.trim() }, { onSuccess: () => navigate("/", { replace: true }) })}
      >
        <p>
          Every sign-in asks for a code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password or similar). Scan this
          QR code with it, then enter the 6-digit code it shows.
        </p>
        {qr && <img className="auth-qr" src={qr} alt="QR code for the authenticator app" />}
        <MessageStrip hideCloseButton>
          Can&apos;t scan? Enter this key in the app instead: <span className="mono">{secret.match(/.{1,4}/g)!.join(" ")}</span>
        </MessageStrip>
        <Field id="code" label="Code" autoComplete="one-time-code" numeric value={code} onChange={setCode} placeholder="123456" />
        <ErrorStrip error={finish.error} />
        <Button type="Submit" design="Emphasized" disabled={!codeComplete || finish.isPending}>
          Finish and sign in
        </Button>
      </AuthForm>
    </AuthFrame>
  );
}
