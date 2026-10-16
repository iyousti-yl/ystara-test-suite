import { Button } from "@ui5/webcomponents-react";
import type { InvitationOffer } from "@ystara/shared";
import { Link, useNavigate, useParams } from "react-router";
import { useAcceptInvitation, useAuthenticatorSetup, useInvitation, useMe, useSignOut } from "../api";
import { AuthFrame } from "../components/AuthFrame";
import { ErrorStrip, Loading } from "../components/Feedback";
import { SetUpSignIn } from "../components/SetUpSignIn";
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
  const setup = useAuthenticatorSetup(token);
  const accept = useAcceptInvitation(token);
  return <SetUpSignIn email={offer.email} title="Welcome to Ystara" intro={invitedTo(offer)} setup={setup} finish={accept} />;
}
