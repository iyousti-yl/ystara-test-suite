import { useState } from "react";
import { Button, Input, Label, MessageStrip, Switch, Title } from "@ui5/webcomponents-react";
import { TEAMS_WEBHOOK_HINT, teamsWebhookHost } from "@ystara/shared";
import { useAccountSettings, useCan, useRemoveTeamsChannel, useSetAccountSettings, useSetTeamsChannel, useTeamsChannel, useTestTeamsChannel } from "../api";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorStrip, Loading } from "../components/Feedback";
import { MoreActions } from "../components/MoreActions";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";

/**
 * The account's settings (/settings), for admins: where alerts go, by email
 * and in a Microsoft Teams channel, and whether scenarios can be drafted with
 * Claude. Alerts come from scheduled snapshots and from scenarios that broke
 * after a scan; each goes by email to the pipeline's watchers and, once a
 * channel is set, is posted there too. The webhook's address is sealed by the
 * API and never shown again: only its host is.
 */
export function SettingsPage() {
  const can = useCan();
  const allowed = can("account.manage");

  if (!allowed) return <PageError heading="You can't open Settings" sentence="Only admins of the account can change its settings. Ask one if something here needs changing." />;

  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Where Ystara sends its alerts, and what this account allows." />
      <section className="block">
        <Title level="H2" size="H4">
          Alerts by email
        </Title>
        <p className="muted section-intro">
          Ystara tells people when a scheduled snapshot found a change, or a scenario broke after a scan. Each alert is emailed to the people who watch its
          pipeline. Anyone who can see a pipeline starts or stops watching it with Watch, at the top of the pipeline&apos;s page.
        </p>
      </section>
      <TeamsSection />
      <DraftingSection />
    </div>
  );
}

function TeamsSection() {
  const channel = useTeamsChannel(true);
  const test = useTestTeamsChannel();
  const remove = useRemoveTeamsChannel();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  return (
    <section className="block">
      <div className="list-toolbar section-toolbar">
        <Title level="H2" size="H4">
          Alerts in Microsoft Teams
        </Title>
        {channel.data && (
          <>
            <Button icon="paper-plane" disabled={test.isPending} onClick={() => test.mutate()}>
              Send a test
            </Button>
            <Button icon="edit" onClick={() => setEditing(true)}>
              Change
            </Button>
            <MoreActions actions={[{ text: "Remove the channel", icon: "delete", disabled: remove.isPending, onClick: () => setRemoving(true) }]} />
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
          Alerts are posted in the channel of the webhook at <span className="mono">{channel.data.host}</span>, set on {formatDateTime(channel.data.updatedAt)}
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
            Alerts only go by email for now. In Teams, add the workflow &quot;Post to a channel when a webhook request is received&quot; to the channel, then
            paste the address it gives here.
          </EmptyState>
        )
      )}
      {editing && <TeamsDialog onClose={() => setEditing(false)} replacing={!!channel.data} />}
      {removing && (
        <Dialog
          headerText="Remove the Teams channel?"
          onClose={() => setRemoving(false)}
          footer={
            <div className="dialog-footer">
              <Button design="Negative" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => setRemoving(false) })}>
                Remove
              </Button>
              <Button design="Transparent" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
            </div>
          }
        >
          <div className="dialog-body">
            <p>Ystara stops posting alerts in this channel. Watchers still get them by email.</p>
            <ErrorStrip error={remove.error} />
          </div>
        </Dialog>
      )}
    </section>
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
          Anyone who has this address can post in the channel, so Ystara keeps it encrypted and never shows it again. A test card is posted first: if Teams
          refuses it, nothing is saved. Alerts carry pipeline, step and scenario names and check labels, never a value read from the tenant.
        </MessageStrip>
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * Whether the scenario builder may ask Claude for a draft (POST /api/pipelines/:id/scenario-draft). Off until an admin
 * switches it on, as it sends the pipeline's definitions outside Ystara; the API writes each change to the audit log.
 */
function DraftingSection() {
  const settings = useAccountSettings(true);
  const save = useSetAccountSettings();
  // While a change is out, the switch shows what was asked for.
  const on = save.isPending ? save.variables.draftingWithClaude : settings.data?.draftingWithClaude;

  return (
    <section className="block">
      <Title level="H2" size="H4">
        Drafting with Claude
      </Title>
      <p className="muted section-intro">
        In a scenario&apos;s builder, someone can describe in a sentence what to test, and Claude drafts the test rows and checks for them to review. To draft,
        Ystara sends Claude the pipeline&apos;s object names, columns and logic, never its data. Claude is made by Anthropic, which processes what is sent on
        Ystara&apos;s behalf. Once this is on, the developers, test coordinators and admins of this account can use it. Switching it on or off is written to
        the audit log.
      </p>
      <ErrorStrip error={settings.error ?? save.error} />
      {settings.isPending ? (
        <Loading />
      ) : (
        settings.data && (
          <div className="switch-row">
            <Switch
              id="drafting-with-claude"
              accessibleNameRef="drafting-with-claude-label"
              checked={on}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ draftingWithClaude: e.target.checked })}
            />
            <Label id="drafting-with-claude-label" for="drafting-with-claude" wrappingType="Normal">
              {on ? "Drafting with Claude is on for this account" : "Drafting with Claude is off for this account"}
            </Label>
          </div>
        )
      )}
      <p className="muted">It also needs Claude set up for this installation of Ystara. If it isn&apos;t, the builder says so.</p>
    </section>
  );
}
