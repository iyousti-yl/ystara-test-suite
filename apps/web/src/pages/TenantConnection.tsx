import { useState } from "react";
import { Button, Input, Label, MessageStrip, Tag, Title } from "@ui5/webcomponents-react";
import { useSearchParams } from "react-router";
import { useCan, useCheckConnection, useConnect, useConnection, useDisconnect, useSetConnectionSpaces, type ConnectionJson, type TenantJson } from "../api";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { ConnectionStatusTag, ErrorStrip, Loading } from "../components/Feedback";
import { QuietNote } from "../components/Info";
import { MoreActions } from "../components/MoreActions";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { spaceIdsOf, tokenUrlProblem } from "../fields";
import { formatDateTime } from "../format";
import { useAddressTenant } from "../tenantScope";

/**
 * Connection › Technical client: how the worker logs in to a tenant, with its
 * technical OAuth client, and the spaces it is meant to scan. Admins connect,
 * change and remove it and change its spaces; anyone who can scan may check
 * it again. The worker checks each space at once, and this page refreshes
 * until the verdict is in (TenantConnection in packages/shared/src/api.ts).
 * `?connect=1` (after adding a tenant, or Home's next step) opens the Connect wizard.
 */
export function TechnicalClientPage() {
  const { tenantId, tenant } = useAddressTenant();
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const connection = useConnection(tenantId);
  const check = useCheckConnection(tenantId);
  const disconnect = useDisconnect(tenantId);
  const [editingSpaces, setEditingSpaces] = useState(false);
  const connecting = params.get("connect") === "1" && can("tenant.connect") && Boolean(tenant.data?.host);
  const setConnecting = (open: boolean) => setParams(open ? { connect: "1" } : {}, { replace: true });
  const c = connection.data;

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <PageError error={tenant.error} what="tenant" />;
  const t = tenant.data;

  const remove = () => {
    if (window.confirm(`Remove the technical client of ${t.name}? Scans stop until an admin connects the tenant again. Its OAuth client in Datasphere stays as it is.`)) {
      disconnect.mutate();
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Technical client"
        subtitle="The OAuth client the worker scans this tenant with, and the spaces it can read."
        actions={
          t.host &&
          c && (
            <>
              {can("discovery.run") && (
                <Button icon="refresh" disabled={c.status === "checking" || check.isPending} onClick={() => check.mutate()}>
                  Check again
                </Button>
              )}
              {can("tenant.connect") && (
                <Button icon="edit" onClick={() => setEditingSpaces(true)}>
                  Change spaces
                </Button>
              )}
              <MoreActions
                actions={[
                  can("tenant.connect") && { text: "Change client", icon: "chain-link", onClick: () => setConnecting(true) },
                  can("tenant.connect") && { text: "Remove client", icon: "delete", disabled: disconnect.isPending, onClick: remove },
                ]}
              />
            </>
          )
        }
      />
      <ErrorStrip error={connection.error ?? check.error ?? disconnect.error} />
      {!t.host ? (
        <QuietNote>This tenant only has imported scans, so there is nothing to connect.</QuietNote>
      ) : connection.isPending ? (
        <Loading />
      ) : !c ? (
        <EmptyState
          icon="connected"
          title="Not connected yet"
          action={
            can("tenant.connect") && (
              <Button design="Emphasized" icon="chain-link" onClick={() => setConnecting(true)}>
                Connect
              </Button>
            )
          }
        >
          {can("tenant.connect")
            ? "Connect this tenant with a technical OAuth client, so the worker can scan it with nobody signed in."
            : "An admin connects this tenant with a technical OAuth client, so the worker can scan it with nobody signed in."}
        </EmptyState>
      ) : (
        <section className="block">
          <div className="facts connection-row">
            <ConnectionStatusTag status={c.status} />
            <span>
              Client <span className="mono">{c.clientId}</span>
            </span>
            {c.checkedAt && <span>Checked {formatDateTime(c.checkedAt)}</span>}
          </div>
          <Verdict connection={c} />
          <Title level="H2" size="H4">Spaces</Title>
          <SpaceResults connection={c} />
        </section>
      )}
      {/* Once loaded, so "Change client" starts from the current client's ID, token URL and spaces. */}
      {connecting && !connection.isPending && <ConnectDialog tenant={t} current={c ?? null} onClose={() => setConnecting(false)} />}
      {editingSpaces && c && <SpacesDialog tenantId={t.id} current={c} onClose={() => setEditingSpaces(false)} />}
    </div>
  );
}

function Verdict({ connection: c }: { connection: ConnectionJson }) {
  if (c.status === "checking") {
    return <p className="muted">The worker is logging in with this client and checking each space. This page refreshes on its own.</p>;
  }
  if (c.status === "failed" && c.error) {
    return (
      <MessageStrip design="Negative" hideCloseButton className="block">
        The worker could not log in with this client. Check the client ID, secret and token URL, and that the client&apos;s purpose is Technical User.
        <pre className="cli-output">{c.error}</pre>
      </MessageStrip>
    );
  }
  if (c.status === "failed") {
    return (
      <MessageStrip design="Negative" hideCloseButton className="block">
        The client logs in, but can read none of these spaces. Add its technical user to them with a scoped role that can read their objects, then check
        again.
      </MessageStrip>
    );
  }
  return null;
}

/** Each space the admin named: readable, not readable (and why), or not checked yet. */
function SpaceResults({ connection: c }: { connection: ConnectionJson }) {
  return (
    <ul className="space-results">
      {c.spaces.map((s) => (
        <li key={s.space}>
          <span className="mono">{s.space}</span>{" "}
          {s.readable === null ? (
            <span className="muted">not checked yet</span>
          ) : s.readable ? (
            <Tag design="Positive">Readable</Tag>
          ) : (
            <>
              <Tag design="Negative">Not readable</Tag>
              {s.error && <pre className="cli-output">{s.error}</pre>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** `problem`: what spaceIdsOf finds wrong with them, under the field. */
function SpacesInput({ value, problem, onInput }: { value: string; problem?: string; onInput: (value: string) => void }) {
  return (
    <>
      <Label for="connection-spaces" required>
        Space IDs
      </Label>
      <Input
        id="connection-spaces"
        className="full-width"
        value={value}
        onInput={(e) => onInput(e.target.value)}
        placeholder="HR, SHARED"
        valueState={problem ? "Negative" : "None"}
        valueStateMessage={<div>{problem}</div>}
      />
      <span className="muted">
        The spaces to scan, separated by commas, as in Space Management (at most 20). The worker checks that the client can read each one: a technical
        client limited to its spaces can&apos;t list them itself.
      </span>
    </>
  );
}

/**
 * The Connect wizard: what to create in Datasphere, then the client's three
 * values and the spaces to scan. The secret is never shown again, so changing
 * the client means entering it again.
 */
function ConnectDialog({ tenant, current, onClose }: { tenant: TenantJson; current: ConnectionJson | null; onClose: () => void }) {
  const connect = useConnect(tenant.id);
  const [clientId, setClientId] = useState(current?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenUrl, setTokenUrl] = useState(current?.tokenUrl ?? "");
  const [spacesText, setSpacesText] = useState(current?.spaces.map((s) => s.space).join(", ") ?? "");
  const { spaces, problem } = spaceIdsOf(spacesText);
  const tokenProblem = tokenUrlProblem(tokenUrl);
  const ready = clientId.trim() && clientSecret.trim() && tokenUrl.trim() && !tokenProblem && spaces.length > 0 && !problem;
  const submit = () =>
    connect.mutate({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), tokenUrl: tokenUrl.trim(), spaces }, { onSuccess: onClose });

  return (
    <Dialog
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
          <li>Add the technical user to each space to scan, with a scoped role that can read the space&apos;s objects (e.g. Viewer).</li>
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
          valueState={tokenProblem ? "Negative" : "None"}
          valueStateMessage={<div>{tokenProblem}</div>}
        />
        <SpacesInput value={spacesText} problem={spacesText.trim() ? problem : undefined} onInput={setSpacesText} />
        <span className="muted">
          Ystara stores the secret encrypted, sends it only to the token URL to log in, and never shows it again. The worker checks the client as soon as
          you save.
        </span>
        <ErrorStrip error={connect.error} />
      </div>
    </Dialog>
  );
}

/** Changes only the spaces to scan: the client and its secret stay as they are. */
function SpacesDialog({ tenantId, current, onClose }: { tenantId: string; current: ConnectionJson; onClose: () => void }) {
  const save = useSetConnectionSpaces(tenantId);
  const [text, setText] = useState(current.spaces.map((s) => s.space).join(", "));
  const { spaces, problem } = spaceIdsOf(text);

  return (
    <Dialog
      headerText="Change the spaces to scan"
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={spaces.length === 0 || !!problem || save.isPending} onClick={() => save.mutate(spaces, { onSuccess: onClose })}>
            Save and check
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <SpacesInput value={text} problem={text.trim() ? problem : undefined} onInput={setText} />
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
