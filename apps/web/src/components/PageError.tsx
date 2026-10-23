import { Button, Panel } from "@ui5/webcomponents-react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { ApiError, useMe } from "../api";
import { pageProblem } from "../errors";
import { AuthFrame } from "./AuthFrame";
import { PageHeader } from "./PageHeader";

/**
 * A page that can't be shown, inside the frame like any other page: a
 * heading, one sentence on why, by the answer's status (deleted or in another
 * account, an incomplete link, not for this role, Ystara out of reach; see
 * pageProblem in errors.ts), and the way Home. `what` names what the link
 * points at ("pipeline"). NotFound gives its own heading and sentence.
 */
export function PageError(props: { error: Error | null | undefined; what: string } | { heading: string; sentence: string }) {
  const navigate = useNavigate();
  const severalAccounts = (useMe().data?.accounts.length ?? 0) > 1;
  const problem = "heading" in props ? { ...props, retry: false } : pageProblem(props.error ?? new Error("Not loaded"), props.what, severalAccounts);
  return (
    <div className="page">
      <PageHeader title={problem.heading} />
      <section className="block">
        <p className="page-intro">{problem.sentence}</p>
        <div className="error-actions">
          <Button design="Emphasized" icon="home" onClick={() => navigate("/")}>
            Home
          </Button>
          {problem.retry && (
            <Button icon="refresh" onClick={() => window.location.reload()}>
              Try again
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * What an error nobody expected says, instead of React Router's own screen with its stack trace: a
 * sentence, Reload and Home (both load the app afresh), and the technical message folded away for
 * whoever looks into it.
 */
function Unexpected() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);
  return (
    <>
      <p className="page-intro">Ystara ran into a problem it didn&apos;t expect and couldn&apos;t show this page. Reload it to try again: what you saved is kept.</p>
      <div className="error-actions">
        <Button design="Emphasized" icon="refresh" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button icon="home" onClick={() => window.location.assign("/")}>
          Home
        </Button>
      </div>
      <Panel headerText="Technical details" collapsed fixed={false}>
        <pre className="cli-output">{message}</pre>
      </Panel>
    </>
  );
}

/** The error element of a page inside the frame. */
export function RouteError() {
  return (
    <div className="page">
      <PageHeader title="Something went wrong" />
      <section className="block">
        <Unexpected />
      </section>
    </div>
  );
}

/** The error element of every page without the frame (signing in, invitation and reset links, a pipeline's report), and the last resort for the rest. */
export function RouteErrorPage() {
  return (
    <AuthFrame title="Something went wrong">
      <Unexpected />
    </AuthFrame>
  );
}

/** The first /auth/me failed for another reason than "not signed in": no frame to show yet, so a card that asks again. */
export function StartError({ error, retrying, onRetry }: { error: Error | null; retrying: boolean; onRetry: () => void }) {
  const unreachable = error instanceof ApiError && error.status === 0;
  return (
    <AuthFrame title={unreachable ? "Ystara can't be reached" : "Ystara couldn't start"}>
      <p>{error?.message ?? "Ystara couldn't check who is signed in."}</p>
      <Button design="Emphasized" icon="refresh" disabled={retrying} onClick={onRetry}>
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </AuthFrame>
  );
}
