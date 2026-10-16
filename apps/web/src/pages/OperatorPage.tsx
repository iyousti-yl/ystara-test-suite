import { useState } from "react";
import { Button, Dialog, Input, Label, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Tag, Title } from "@ui5/webcomponents-react";
import type { Json, UserOverview } from "@ystara/shared";
import { useAccountOverviews, useCreateAccount, useCreateReset, useInviteAdmin, useMe, useUserOverviews } from "../api";
import { ErrorStrip, Loading } from "../components/Feedback";
import { LinkToSend } from "../components/LinkToSend";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { ROLE_LABEL } from "../roles";

/**
 * The operator panel (/operator), for whoever runs Ystara: every customer
 * account and user, creating accounts, a new admin for an account, and reset
 * links. It shows counts, never tenants, scans or pipelines.
 */
export function OperatorPage() {
  const isOperator = useMe().data?.operator ?? false;
  const accounts = useAccountOverviews(isOperator);
  const users = useUserOverviews(isOperator);
  const [dialog, setDialog] = useState<{ kind: "account" } | { kind: "admin"; accountId: string; name: string } | { kind: "reset"; user: Json<UserOverview> }>();

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
        <Title level="H4">Accounts</Title>
        {accounts.isPending ? (
          <Loading />
        ) : (
          <Table
            noDataText="No accounts yet."
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell horizontalAlign="End">Members</TableHeaderCell>
                <TableHeaderCell horizontalAlign="End">Tenants</TableHeaderCell>
                <TableHeaderCell horizontalAlign="End">Open invitations</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell horizontalAlign="End">
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
                <TableCell horizontalAlign="End">{a.members}</TableCell>
                <TableCell horizontalAlign="End">{a.tenants}</TableCell>
                <TableCell horizontalAlign="End">{a.openInvitations || "–"}</TableCell>
                <TableCell>{formatDateTime(a.createdAt)}</TableCell>
                <TableCell horizontalAlign="End">
                  <Button design="Transparent" onClick={() => setDialog({ kind: "admin", accountId: a.id, name: a.name })}>
                    Invite an admin
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      <section className="block">
        <Title level="H4">Users</Title>
        {users.isPending ? (
          <Loading />
        ) : (
          <Table
            noDataText="No users yet."
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Accounts and roles</TableHeaderCell>
                <TableHeaderCell>Since</TableHeaderCell>
                <TableHeaderCell horizontalAlign="End">
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
                  <Button design="Transparent" onClick={() => setDialog({ kind: "reset", user: u })}>
                    Reset sign-in
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      {dialog?.kind === "account" && <CreateAccountDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "admin" && <InviteAdminDialog accountId={dialog.accountId} name={dialog.name} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "reset" && <ResetDialog user={dialog.user} onClose={() => setDialog(undefined)} />}
    </div>
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
      open
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
          <Input id="account-name" value={name} onInput={(e) => setName(e.target.value)} />
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
      open
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
      open
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
            their accounts. Their current sign-in keeps working until the link is used, and an earlier reset link stops working.
          </p>
          <ErrorStrip error={reset.error} />
        </div>
      )}
    </Dialog>
  );
}
