import { Link, useParams } from "react-router";
import { useAcceptReset, useReset, useResetAuthenticator } from "../api";
import { AuthFrame } from "../components/AuthFrame";
import { ErrorStrip, Loading } from "../components/Feedback";
import { SetUpSignIn } from "../components/SetUpSignIn";

/**
 * A reset link, /reset/:token, made on the operator panel for someone who lost
 * their password or phone: a new password and a new authenticator, then signed in.
 * Every other sign-in of that user ends.
 */
export function ResetPage() {
  const { token = "" } = useParams();
  const offer = useReset(token);
  const setup = useResetAuthenticator(token);
  const accept = useAcceptReset(token);

  if (offer.isPending) return <Loading />;
  if (!offer.data) {
    return (
      <AuthFrame title="Reset your sign-in">
        <ErrorStrip error={offer.error} />
        <Link to="/sign-in">Go to sign in</Link>
      </AuthFrame>
    );
  }
  return (
    <SetUpSignIn
      email={offer.data.email}
      title="Reset your sign-in"
      intro={<p>This link replaces your password and your authenticator app. Any browser still signed in as you is signed out.</p>}
      setup={setup}
      finish={accept}
    />
  );
}
