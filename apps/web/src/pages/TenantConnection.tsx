import { useState } from "react";
import { Button, Dialog, Input, Label, MessageStrip, Title } from "@ui5/webcomponents-react";
import { useCan, useCheckConnection, useConnect, useConnection, useDisconnect, type ConnectionJson, type TenantJson } from "../api";
import { ConnectionStatusTag, ErrorStrip, Loading } from "../components/Feedback";
import { formatDateTime } from "../format";

/**
 * How the worker logs in to a tenant: its technical OAuth client. Admins
 * connect, change and remove it; anyone who can scan may check it again. The
 * worker checks a new client at once, and this section refreshes until the
 * verdict is in (TenantConnection in packages/shared/src/api.ts).
 */
export function ConnectionSection({ tenant, connecting, onConnecting }: { tenant: TenantJson; connecting: boolean; onConnecting: (open: boolean) => void }) {
  const can = useCan();
  const connection = useConnection(tenant.id);
  const check = useCheckConnection(tenant.id);
  const disconnect = useDisconnect(tenant.id);
  const c = connection.data;

  const remove = () => {
    if (window.confirm(`Remove the technical client of ${tenant.name}? Scans stop until an admin connects the tenant again. Its OAuth client in Datasphere stays as it is.`)) {
      disconnect.mutate();
    }
  };

  return (
    <section className="block">
      <Title level="H4">Connection</Title>
      <ErrorStrip error={connection.error ?? check.error ?? disconnect.error} />
      {connection.isPending ? (
        <Loading />
      ) : !c ? (
        <MessageStrip design="Information" hideCloseButton className="block">
          {can("tenant.connect")
            ? "Not connected yet. Connect this tenant with a technical OAuth client, so the worker can scan it with nobody signed in."
            : "Not connected yet. An admin connects this tenant with a technical OAuth client."}
        </MessageStrip>
      ) : (
        <>
          <div className="facts connection-row">
            <ConnectionStatusTag status={c.status} />
            <span>
              Client <span className="mono">{c.clientId}</span>
            </span>
            {c.checkedAt && <span>Checked {formatDateTime(c.checkedAt)}</span>}
          </div>
          <Verdict connection={c} />
        </>
      )}
      <div className="page-header-actions connection-row">
        {can("tenant.connect") && (
          <Button design={c ? "Default" : "Emphasized"} icon="chain-link" onClick={() => onConnecting(true)}>
            {c ? "Change client" : "Connect"}
          </Button>
        )}
        {c && can("discovery.run") && (
          <Button icon="refresh" disabled={c.status === "checking" || check.isPending} onClick={() => check.mutate()}>
            Check again
          </Button>
        )}
        {c && can("tenant.connect") && (
          <Button design="Transparent" icon="delete" disabled={disconnect.isPending} onClick={remove}>
            Remove
          </Button>
        )}
      </div>
      {/* Once loaded, so "Change client" starts from the current client's ID and token URL. */}
      {connecting && !connection.isPending && <ConnectDialog tenant={tenant} current={c ?? null} onClose={() => onConnecting(false)} />}
    </section>
  );
}

function Verdict({ connection: c }: { connection: ConnectionJson }) {
  if (c.status === "checking") {
    return <p className="muted">The worker is logging in with this client and listing the spaces it can see. This section refreshes on its own.</p>;
  }
  if (c.status === "failed") {
    return (
      <MessageStrip design="Negative" hideCloseButton className="block">
        The worker could not log in with this client. Check the client ID, secret and token URL, and that the client&apos;s purpose is Technical User.
        {c.error && <pre className="cli-output">{c.error}</pre>}
      </MessageStrip>
    );
  }
  if (c.spaces.length === 0) {
    return (
      <MessageStrip design="Critical" hideCloseButton className="block">
        The client logs in, but sees no space yet. Add it to the spaces to scan, then check again.
      </MessageStrip>
    );
  }
  return (
    <p>
      Sees {c.spaces.length === 1 ? "1 space" : `${c.spaces.length} spaces`}: <span className="mono">{c.spaces.join(", ")}</span>
    </p>
  );
}

/**
 * The Connect wizard: what to create in Datasphere, then the client's three
 * values. The secret is never shown again, so changing the client means
 * entering it again.
 */
function ConnectDialog({ tenant, current, onClose }: { tenant: TenantJson; current: ConnectionJson | null; onClose: () => void }) {
  const connect = useConnect(tenant.id);
  const [clientId, setClientId] = useState(current?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenUrl, setTokenUrl] = useState(current?.tokenUrl ?? "");
  const ready = clientId.trim() && clientSecret.trim() && tokenUrl.trim();
  const submit = () =>
    connect.mutate({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), tokenUrl: tokenUrl.trim() }, { onSuccess: onClose });

  return (
    <Dialog
      open
      headerText={current ? "Change the technical client" : `Connect ${tenant.name}`}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={!ready || connect.isPending} onClick={submit}>
            Save and check
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>Ystara only lists and reads object definitions. A Datasphere admin prepares a client for it once:</p>
        <ol className="steps-to-do">
          <li>
            In {tenant.host ? <span className="mono">{tenant.host}</span> : "Datasphere"}, open System › Administration › App Integration and choose Add a
            New OAuth Client.
          </li>
          <li>Set its purpose to Technical User and name it Ystara. Copy its client ID and secret: Datasphere shows the secret only once.</li>
          <li>Copy the token URL shown on the App Integration page.</li>
          <li>Add the technical user to each space to scan, with the least role that can see its objects.</li>
        </ol>
        <Label for="client-id" required>
          Client ID
        </Label>
        <Input id="client-id" className="full-width" value={clientId} onInput={(e) => setClientId(e.target.value)} placeholder="sb-…" />
        <Label for="client-secret" required>
          Client secret
        </Label>
        <Input
          id="client-secret"
          className="full-width"
          type="Password"
          value={clientSecret}
          onInput={(e) => setClientSecret(e.target.value)}
          placeholder={current ? "Enter it again: Ystara never shows it" : undefined}
        />
        <Label for="token-url" required>
          Token URL
        </Label>
        <Input
          id="token-url"
          className="full-width"
          type="URL"
          value={tokenUrl}
          onInput={(e) => setTokenUrl(e.target.value)}
          placeholder="https://….authentication.eu10.hana.ondemand.com/oauth/token"
        />
        <span className="muted">
          Ystara stores the secret encrypted, sends it only to the token URL to log in, and never shows it again. The worker checks the client as soon as
          you save.
        </span>
        <ErrorStrip error={connect.error} />
      </div>
    </Dialog>
  );
}
