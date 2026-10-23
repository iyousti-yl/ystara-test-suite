import { useState } from "react";
import { Button, MessageStrip, Title } from "@ui5/webcomponents-react";
import { MIN_PASSWORD_LENGTH } from "@ystara/shared";
import { useChangePassword, useEndOtherSessions, useMe } from "../api";
import { AuthForm, Field } from "../components/AuthFrame";
import { ErrorStrip } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { counted } from "../format";

/**
 * Sign-in and security (/security), for everyone: a new password, and
 * signing out the other browsers signed in as you. A new password signs
 * those out too (the API does it); this browser stays signed in.
 */
export function SecurityPage() {
  return (
    <div className="page">
      <PageHeader title="Sign-in and security" subtitle="Your password, and the other browsers signed in as you." />
      <PasswordSection />
      <OtherBrowsersSection />
    </div>
  );
}

/** The fields are the sign-in pages' plain inputs (AuthFrame's Field), so a password manager offers to update the saved password. */
function PasswordSection() {
  const me = useMe().data!;
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");

  const tooShort = next !== "" && [...next.normalize("NFKC")].length < MIN_PASSWORD_LENGTH;
  const mismatch = repeat !== "" && repeat !== next;
  const codeComplete = code.replace(/\s/g, "").length === 6;
  const ready = current !== "" && next !== "" && !tooShort && repeat === next && codeComplete;

  // A second Enter while the change is out sends nothing: the code it carries can't be used twice.
  const submit = () => {
    if (!ready || change.isPending) return;
    change.mutate(
      { currentPassword: current, newPassword: next, code: code.trim() },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setRepeat("");
          setCode("");
        },
        // A wrong password or code: the next try needs a fresh code.
        onError: () => setCode(""),
      },
    );
  };

  return (
    <section className="block">
      <Title level="H2" size="H4">
        Password
      </Title>
      <p className="muted">
        Changing it signs out every other browser signed in as you; this one stays signed in. You need your current password and a code from your authenticator
        app.
      </p>
      <AuthForm onSubmit={submit}>
        <div className="security-form">
          {/* Tells a password manager whose password this is. */}
          <input type="email" autoComplete="username" value={me.user.email} readOnly hidden />
          <Field id="current-password" label="Current password" type="password" autoComplete="current-password" value={current} onChange={setCurrent} />
          <Field id="new-password" label="New password" type="password" autoComplete="new-password" value={next} onChange={setNext} invalid={tooShort} />
          <span className="muted">Use at least {MIN_PASSWORD_LENGTH} characters; a few unrelated words work well.</span>
          <Field id="repeat-password" label="New password again" type="password" autoComplete="new-password" value={repeat} onChange={setRepeat} invalid={mismatch} />
          {mismatch && <span className="muted">The two passwords are not the same.</span>}
          <Field id="password-code" label="Code from your authenticator app" autoComplete="one-time-code" numeric value={code} onChange={setCode} placeholder="123456" />
          <ErrorStrip error={change.error} />
          {change.isSuccess && (
            <MessageStrip design="Positive" hideCloseButton>
              Your password was changed. Other browsers signed in as you were signed out.
            </MessageStrip>
          )}
          <div>
            <Button type="Submit" design="Emphasized" disabled={!ready || change.isPending}>
              Change password
            </Button>
          </div>
        </div>
      </AuthForm>
    </section>
  );
}

/** How many other browsers are signed in as you (Me.otherSessions), and a button that signs them out. */
function OtherBrowsersSection() {
  const me = useMe().data!;
  const end = useEndOtherSessions();
  const others = me.otherSessions;

  return (
    <section className="block">
      <Title level="H2" size="H4">
        Other browsers
      </Title>
      <p className="muted">
        Signed in on a shared or lost computer? Sign it out from here: it asks for your password and a code again. Ystara also signs a browser out after an
        hour without use.
      </p>
      {others > 0 ? (
        <>
          <p>{counted(others, "other browser")} signed in as you right now.</p>
          <div>
            <Button icon="log" disabled={end.isPending} onClick={() => !end.isPending && end.mutate()}>
              Sign out your other browsers
            </Button>
          </div>
        </>
      ) : (
        <p>No other browser is signed in as you.</p>
      )}
      <ErrorStrip error={end.error} />
      {end.isSuccess && others === 0 && (
        <MessageStrip design="Positive" hideCloseButton>
          {counted(end.data.ended, "browser")} signed out.
        </MessageStrip>
      )}
    </section>
  );
}
