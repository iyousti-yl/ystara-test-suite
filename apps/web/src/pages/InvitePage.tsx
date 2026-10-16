import { useEffect, useState } from "react";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { MIN_PASSWORD_LENGTH, type InvitationOffer } from "@ystara/shared";
import QRCode from "qrcode";
import { Link, useNavigate, useParams } from "react-router";
import { useAcceptInvitation, useAuthenticatorSetup, useInvitation, useMe, useSignOut } from "../api";
import { AuthForm, AuthFrame, Field } from "../components/AuthFrame";
import { ErrorStrip, Loading } from "../components/Feedback";
import { ROLE_LABEL } from "../roles";

/**
 * An invitation link, /invite/:token. Someone new chooses a password and sets
 * up an authenticator app; someone who already uses Ystara in another account
 * signs in as that email and joins.
 */
export function InvitePage() {
  const { token = "" } = useParams();
  const offer = useInvitation(token);

  if (offer.isPending) return <Loading />;
  if (!offer.data) {
    return (
      <AuthFrame title="Invitation">
        <ErrorStrip error={offer.error} />
        <Link to="/sign-in">Go to sign in</Link>
      </AuthFrame>
    );
  }
  return offer.data.existingUser ? <JoinAsExistingUser token={token} offer={offer.data} /> : <NewUser token={token} offer={offer.data} />;
}

const invitedTo = (offer: InvitationOffer) => (
  <p>
    You are invited to <b>{offer.account}</b> as <b>{ROLE_LABEL[offer.role]}</b>.
  </p>
);

function JoinAsExistingUser({ token, offer }: { token: string; offer: InvitationOffer }) {
  const me = useMe();
  const accept = useAcceptInvitation(token);
  const signOut = useSignOut();
  const navigate = useNavigate();
  const signInAs = () => navigate(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);

  if (me.isPending) return <Loading />;
  const isThem = me.data?.user.email === offer.email;
  return (
    <AuthFrame title={`Join ${offer.account}`}>
      {invitedTo(offer)}
      {isThem ? (
        <>
          <p>You will find it in the account menu, next to {me.data!.account.name}.</p>
          <ErrorStrip error={accept.error} />
          <Button design="Emphasized" disabled={accept.isPending} onClick={() => accept.mutate({}, { onSuccess: () => navigate("/", { replace: true }) })}>
            Join {offer.account}
          </Button>
        </>
      ) : (
        <>
          <p>
            {offer.email} already has a Ystara sign-in. Sign in as {offer.email} to accept.
            {me.data && ` You are signed in as ${me.data.user.email} now.`}
          </p>
          <Button design="Emphasized" onClick={() => (me.data ? signOut.mutate(undefined, { onSettled: signInAs }) : signInAs())}>
            {me.data ? `Sign out and sign in as ${offer.email}` : `Sign in as ${offer.email}`}
          </Button>
        </>
      )}
    </AuthFrame>
  );
}

function NewUser({ token, offer }: { token: string; offer: InvitationOffer }) {
  const navigate = useNavigate();
  const setup = useAuthenticatorSetup(token);
  const accept = useAcceptInvitation(token);
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
      <AuthFrame title="Welcome to Ystara">
        {invitedTo(offer)}
        <AuthForm key="password" onSubmit={() => passwordOk && setup.mutate()}>
          <p>Choose a password for {offer.email}. Use at least {MIN_PASSWORD_LENGTH} characters; a few unrelated words work well.</p>
          {/* Tells a password manager which user the new password belongs to. */}
          <input type="email" autoComplete="username" value={offer.email} readOnly hidden />
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
        onSubmit={() => codeComplete && accept.mutate({ password, totpSecret: secret, code: code.trim() }, { onSuccess: () => navigate("/", { replace: true }) })}
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
        <ErrorStrip error={accept.error} />
        <Button type="Submit" design="Emphasized" disabled={!codeComplete || accept.isPending}>
          Finish and sign in
        </Button>
      </AuthForm>
    </AuthFrame>
  );
}
