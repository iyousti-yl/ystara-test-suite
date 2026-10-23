import { useState } from "react";
import { Button, Input, Label, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Tag, Title } from "@ui5/webcomponents-react";
import type { Json, UserOverview } from "@ystara/shared";
import {
  useAccountOverviews,
  useClaudeSetting,
  useCreateAccount,
  useCreateReset,
  useInviteAdmin,
  useMe,
  useRenameAccountAsOperator,
  useSetClaudeKey,
  useUserOverviews,
} from "../api";
import { Dialog } from "../components/Dialog";
import { ErrorStrip, Loading } from "../components/Feedback";
import { InfoButton, QuietNote } from "../components/Info";
import { LinkToSend } from "../components/LinkToSend";
import { MoreActions } from "../components/MoreActions";
import { PageHeader } from "../components/PageHeader";
import { RenameAccountDialog } from "../components/RenameAccountDialog";
import { NAME_MAX } from "../fields";
import { formatDateTime } from "../format";
import { ROLE_LABEL } from "../roles";

/**
 * The operator panel (/operator), for whoever runs Ystara: every customer
 * account and user, creating and renaming accounts, a new admin for an
 * account, and reset links. It shows counts, never tenants, scans or pipelines.
 * It also takes the server's Anthropic API key, for drafting scenarios with Claude.
 */
export function OperatorPage() {
  const isOperator = useMe().data?.operator ?? false;
  const accounts = useAccountOverviews(isOperator);
  const users = useUserOverviews(isOperator);
  const [dialog, setDialog] = useState<
    { kind: "account" } | { kind: "admin" | "rename"; accountId: string; name: string } | { kind: "reset"; user: Json<UserOverview> }
  >();
  const rename = useRenameAccountAsOperator();
  const closeDialog = () => {
    setDialog(undefined);
    rename.reset();
  };

  if (!isOperator) {
    return (
      <div className="page">
        <ErrorStrip error={new Error("Only Ystara's operator can open this page.")} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Operator"
        subtitle="Every customer account and user. Only operators see this page, and it shows no tenant data."
        actions={
          <Button design="Emphasized" icon="add" onClick={() => setDialog({ kind: "account" })}>
            Create account
          </Button>
        }
      />
      <ErrorStrip error={accounts.error ?? users.error} />

      <section className="block">
        <Title level="H2" size="H4">Accounts</Title>
        {accounts.isPending ? (
          <Loading />
        ) : (
          <Table
            noDataText="No accounts yet."
            overflowMode="Popin"
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell minWidth="10rem" importance={1}>
                  Name
                </TableHeaderCell>
                <TableHeaderCell minWidth="6rem" width="7rem" horizontalAlign="End">
                  Members
                </TableHeaderCell>
                <TableHeaderCell minWidth="6rem" width="7rem" horizontalAlign="End">
                  Tenants
                </TableHeaderCell>
                <TableHeaderCell minWidth="8rem" width="9rem" horizontalAlign="End">
                  Open invitations
                </TableHeaderCell>
                <TableHeaderCell minWidth="10rem">Created</TableHeaderCell>
                <TableHeaderCell minWidth="7rem" importance={1} horizontalAlign="End">
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {accounts.data?.map((a) => (
              <TableRow key={a.id} rowKey={a.id}>
                <TableCell>
                  {a.name}
                  {a.admins === 0 && (
                    <Tag design="Critical" className="tag-after">
                      No admin
                    </Tag>
                  )}
                </TableCell>
                <TableCell horizontalAlign="End" className="mono">{a.members}</TableCell>
                <TableCell horizontalAlign="End" className="mono">{a.tenants}</TableCell>
                <TableCell horizontalAlign="End" className="mono">{a.openInvitations || "–"}</TableCell>
                <TableCell>{formatDateTime(a.createdAt)}</TableCell>
                <TableCell horizontalAlign="End">
                  <Button design="Transparent" onClick={() => setDialog({ kind: "rename", accountId: a.id, name: a.name })}>
                    Rename
                  </Button>
                  {/* Where an admin is left, they invite people themselves; the API refuses it too. */}
                  {a.admins === 0 && (
                    <Button design="Transparent" onClick={() => setDialog({ kind: "admin", accountId: a.id, name: a.name })}>
                      Invite an admin
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      <section className="block">
        <Title level="H2" size="H4">Users</Title>
        {users.isPending ? (
          <Loading />
        ) : (
          <Table
            noDataText="No users yet."
            overflowMode="Popin"
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell minWidth="12rem" importance={1}>
                  Email
                </TableHeaderCell>
                <TableHeaderCell minWidth="12rem">Accounts and roles</TableHeaderCell>
                <TableHeaderCell minWidth="10rem">Since</TableHeaderCell>
                <TableHeaderCell minWidth="8rem" importance={1} horizontalAlign="End">
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {users.data?.map((u) => (
              <TableRow key={u.id} rowKey={u.id}>
                <TableCell>
                  {u.email}
                  {u.operator && (
                    <Tag design="Information" className="tag-after">
                      Operator
                    </Tag>
                  )}
                </TableCell>
                <TableCell>{u.accounts.map((a) => `${a.name}: ${ROLE_LABEL[a.role]}`).join(", ") || <span className="muted">None</span>}</TableCell>
                <TableCell>{formatDateTime(u.createdAt)}</TableCell>
                <TableCell horizontalAlign="End">
                  {/* An operator's sign-in is never reset from here: one operator would take over another. */}
                  {!u.operator && (
                    <Button design="Transparent" onClick={() => setDialog({ kind: "reset", user: u })}>
                      Reset sign-in
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      <ClaudeSection />

      {dialog?.kind === "account" && <CreateAccountDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "admin" && <InviteAdminDialog accountId={dialog.accountId} name={dialog.name} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "reset" && <ResetDialog user={dialog.user} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "rename" && (
        <RenameAccountDialog
          current={dialog.name}
          pending={rename.isPending}
          error={rename.error}
          onRename={(name) => rename.mutate({ accountId: dialog.accountId, name }, { onSuccess: closeDialog })}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

/** The Anthropic API key drafting uses: whether one is set and since when, entering one, removing it. */
function ClaudeSection() {
  const setting = useClaudeSetting(true);
  const setKey = useSetClaudeKey();
  const [apiKey, setApiKey] = useState("");
  const s = setting.data;
  return (
    <section className="block">
      <span className="title-with-info">
        <Title level="H2" size="H4">
          Drafting scenarios with Claude
        </Title>
        <InfoButton label="About drafting with Claude">
          With an Anthropic API key, the scenario builder drafts test rows and checks from a scenario&apos;s description. Each draft sends the description and
          the pipeline&apos;s definitions (object and column names, types and each step&apos;s SQL) to Anthropic, never tenant data, and is paid on this key.
          Each account&apos;s admins switch it on for their account under Settings.
        </InfoButton>
      </span>
      <ErrorStrip error={setting.error ?? setKey.error} />
      {s && (
        <p>
          {s.source === "environment"
            ? "On, with the server's own ANTHROPIC_API_KEY. It wins over a key entered here."
            : s.operatorKey
              ? `On, with the key entered ${formatDateTime(s.operatorKey.updatedAt)}${s.operatorKey.updatedBy ? ` by ${s.operatorKey.updatedBy}` : ""}.`
              : "Off: no key yet. The builder doesn't offer drafting."}
        </p>
      )}
      {setKey.isSuccess && setKey.variables !== null && (
        <QuietNote tone="ok">Anthropic accepted the key. It is kept sealed and isn&apos;t shown again.</QuietNote>
      )}
      <div className="claude-key">
        <Label for="claude-key">{s?.operatorKey ? "Replace the key" : "Anthropic API key"}</Label>
        <div className="claude-key-row">
          <Input id="claude-key" type="Password" value={apiKey} placeholder="sk-ant-…" onInput={(e) => setApiKey(e.target.value)} />
          <Button disabled={!apiKey.trim() || setKey.isPending} onClick={() => setKey.mutate(apiKey.trim(), { onSuccess: () => setApiKey("") })}>
            {setKey.isPending && setKey.variables !== null ? "Checking…" : "Check and save"}
          </Button>
          <MoreActions
            actions={[
              s?.operatorKey && {
                text: "Remove the key",
                icon: "delete",
                disabled: setKey.isPending,
                onClick: () => {
                  if (window.confirm("Remove the Anthropic API key? The builder stops offering drafting, unless the server has its own key.")) setKey.mutate(null);
                },
              },
            ]}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * A dialog's buttons: the action while nothing is done yet, then Done. A plain function, not a
 * component: UI5 puts what it returns in the footer slot only when the slot attribute lands on a DOM element.
 */
function footer(props: { done: boolean; action: string; disabled: boolean; onAction: () => void; onClose: () => void }) {
  return (
    <div className="dialog-footer">
      {props.done ? (
        <Button design="Emphasized" onClick={props.onClose}>
          Done
        </Button>
      ) : (
        <>
          <Button design="Emphasized" disabled={props.disabled} onClick={props.onAction}>
            {props.action}
          </Button>
          <Button design="Transparent" onClick={props.onClose}>
            Cancel
          </Button>
        </>
      )}
    </div>
  );
}

function CreateAccountDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateAccount();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const done = create.data;
  return (
    <Dialog
      headerText={done ? `Account ${done.account.name} created` : "Create an account"}
      onClose={onClose}
      footer={footer({
        done: !!done,
        action: "Create account",
        disabled: !name.trim() || !email.trim() || create.isPending,
        onAction: () => create.mutate({ name: name.trim(), adminEmail: email.trim() }),
        onClose,
      })}
    >
      {done ? (
        <LinkToSend
          path={`/invite/${done.token}`}
          to={done.invitation.email}
          until={done.invitation.expiresAt}
          purpose="They become the account's first admin and invite their team from there."
        />
      ) : (
        <div className="dialog-body">
          <Label for="account-name" required>
            Customer name
          </Label>
          <Input id="account-name" value={name} maxlength={NAME_MAX} onInput={(e) => setName(e.target.value)} />
          <Label for="account-admin" required>
            Email of its first admin
          </Label>
          <Input id="account-admin" type="Email" value={email} onInput={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          <ErrorStrip error={create.error} />
        </div>
      )}
    </Dialog>
  );
}

function InviteAdminDialog({ accountId, name, onClose }: { accountId: string; name: string; onClose: () => void }) {
  const invite = useInviteAdmin();
  const [email, setEmail] = useState("");
  const done = invite.data;
  return (
    <Dialog
      headerText={done ? "Send this link" : `Invite an admin to ${name}`}
      onClose={onClose}
      footer={footer({
        done: !!done,
        action: "Create invitation link",
        disabled: !email.trim() || invite.isPending,
        onAction: () => invite.mutate({ accountId, email: email.trim() }),
        onClose,
      })}
    >
      {done ? (
        <LinkToSend path={`/invite/${done.token}`} to={done.invitation.email} until={done.invitation.expiresAt} purpose={`They join ${name} as an admin.`} />
      ) : (
        <div className="dialog-body">
          <p>For an account whose admins are gone or locked out. Someone who already uses Ystara signs in first and then joins.</p>
          <Label for="admin-email" required>
            Email
          </Label>
          <Input id="admin-email" type="Email" value={email} onInput={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          <ErrorStrip error={invite.error} />
        </div>
      )}
    </Dialog>
  );
}

function ResetDialog({ user, onClose }: { user: Json<UserOverview>; onClose: () => void }) {
  const reset = useCreateReset();
  const done = reset.data;
  return (
    <Dialog
      headerText={done ? "Send this link" : `Reset the sign-in of ${user.email}?`}
      onClose={onClose}
      footer={footer({ done: !!done, action: "Create reset link", disabled: reset.isPending, onAction: () => reset.mutate(user.id), onClose })}
    >
      {done ? (
        <LinkToSend
          path={`/reset/${done.token}`}
          to={user.email}
          until={done.expiresAt}
          purpose="There they choose a new password and set up their authenticator app again; every browser signed in as them is signed out."
        />
      ) : (
        <div className="dialog-body">
          <p>
            For someone who lost their password or phone. Check first that the request really comes from {user.email}: the link gives full access to
            their accounts. Their current sign-in keeps working until the link is used, and an earlier reset link stops working. The admins of their
            accounts see that Ystara made the link, and when it was used.
          </p>
          <ErrorStrip error={reset.error} />
        </div>
      )}
    </Dialog>
  );
}
