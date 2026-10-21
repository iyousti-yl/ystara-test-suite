import { useState } from "react";
import { Button, Dialog, Input, Label, MessageStrip, Title } from "@ui5/webcomponents-react";
import { TEAMS_WEBHOOK_HINT, teamsWebhookHost } from "@ystara/shared";
import { useCan, useRemoveTeamsChannel, useSetTeamsChannel, useTeamsChannel, useTestTeamsChannel } from "../api";
import { EmptyState } from "../components/EmptyState";
import { ErrorStrip, Loading } from "../components/Feedback";
import { MoreActions } from "../components/MoreActions";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";

/**
 * The account's alerts (/alerts), for admins: who gets them, and its
 * Microsoft Teams channel. Alerts come from scheduled snapshots and from
 * scenarios that broke after a scan; each goes by email to the pipeline's
 * watchers and, once a channel is set, is posted there too. The webhook's
 * address is sealed by the API and never shown again: only its host is.
 */
export function AlertsPage() {
  const can = useCan();
  const allowed = can("account.manage");
  const channel = useTeamsChannel(allowed);
  const test = useTestTeamsChannel();
  const remove = useRemoveTeamsChannel();
  const [editing, setEditing] = useState(false);

  if (!allowed) {
    return (
      <div className="page">
        <ErrorStrip error={new Error("Only admins can set where alerts go.")} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Alerts" subtitle="Where Ystara tells people that a scheduled snapshot found a change, or that a scenario broke after a scan." />
      <section className="block">
        <Title level="H2" size="H4">Email</Title>
        <p className="muted section-intro">
          Each alert is emailed to the people who watch its pipeline. Anyone who can see a pipeline starts or stops watching it with Watch, at the top of the pipeline's page.
        </p>
      </section>
      <section className="block">
        <div className="list-toolbar section-toolbar">
          <Title level="H2" size="H4">Microsoft Teams channel</Title>
          {channel.data && (
            <>
              <Button icon="paper-plane" disabled={test.isPending} onClick={() => test.mutate()}>
                Send a test
              </Button>
              <Button icon="edit" onClick={() => setEditing(true)}>
                Change
              </Button>
              <MoreActions
                actions={[
                  {
                    text: "Remove the channel",
                    icon: "delete",
                    disabled: remove.isPending,
                    onClick: () => {
                      if (window.confirm("Stop posting alerts in this Teams channel? Watchers still get them by email.")) remove.mutate();
                    },
                  },
                ]}
              />
            </>
          )}
        </div>
        <ErrorStrip error={channel.error ?? test.error ?? remove.error} />
        {test.isSuccess && (
          <MessageStrip design="Information" hideCloseButton className="block">
            A test card was posted. It should show in the channel within a minute.
          </MessageStrip>
        )}
        {channel.isPending ? (
          <Loading />
        ) : channel.data ? (
          <p className="wrap-anywhere">
            Alerts are posted in the channel of the webhook at <span className="mono">{channel.data.host}</span>, set on{" "}
            {formatDateTime(channel.data.updatedAt)}
            {channel.data.updatedBy && <span> by {channel.data.updatedBy}</span>}.
          </p>
        ) : (
          channel.isSuccess && (
            <EmptyState
              icon="bell"
              title="No Teams channel yet"
              action={
                <Button design="Emphasized" icon="add" onClick={() => setEditing(true)}>
                  Connect a channel
                </Button>
              }
            >
              Alerts only go by email for now. In Teams, add the workflow &quot;Post to a channel when a webhook request is received&quot; to the channel,
              then paste the address it gives here.
            </EmptyState>
          )
        )}
      </section>
      {editing && <TeamsDialog onClose={() => setEditing(false)} replacing={!!channel.data} />}
    </div>
  );
}

/** Paste the webhook's address: the API posts a test card to it and keeps it only if Teams takes it. */
function TeamsDialog({ onClose, replacing }: { onClose: () => void; replacing: boolean }) {
  const save = useSetTeamsChannel();
  const [url, setUrl] = useState("");
  const host = teamsWebhookHost(url);
  const typed = url.trim().length > 0;

  return (
    <Dialog
      open
      headerText={replacing ? "Change the Teams channel" : "Connect a Teams channel"}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={!host || save.isPending} onClick={() => save.mutate(url.trim(), { onSuccess: onClose })}>
            Send a test and save
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <Label for="teams-url" required>
          Webhook address
        </Label>
        <Input
          id="teams-url"
          className="mono full-width"
          type="Password"
          value={url}
          valueState={typed && !host ? "Negative" : "None"}
          onInput={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        >
          {typed && !host && <div slot="valueStateMessage">This isn&apos;t the address of a Teams webhook.</div>}
        </Input>
        <p className="muted">{TEAMS_WEBHOOK_HINT}</p>
        <MessageStrip design="Information" hideCloseButton>
          Anyone who has this address can post in the channel, so Ystara keeps it encrypted and never shows it again. A test card is posted first: if
          Teams refuses it, nothing is saved. Alerts carry pipeline, step and scenario names and check labels, never a value read from the tenant.
        </MessageStrip>
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
