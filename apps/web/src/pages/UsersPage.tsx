import { useState } from "react";
import {
  Button,
  Dialog,
  Input,
  Label,
  MessageStrip,
  Option,
  Select,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Title,
} from "@ui5/webcomponents-react";
import { ROLES, type Role } from "@ystara/shared";
import { useCan, useChangeRole, useInvite, useMe, useRemoveMember, useTeam, useWithdrawInvitation } from "../api";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { ROLE_LABEL, ROLE_SUMMARY } from "../roles";

/**
 * The account's admin page (/users): who can sign in to this account, with
 * which role, and the invitations still open. Admins only; the API checks it too.
 */
export function UsersPage() {
  const can = useCan();
  const me = useMe().data!;
  const team = useTeam(can("users.manage"));
  const changeRole = useChangeRole();
  const remove = useRemoveMember();
  const withdraw = useWithdrawInvitation();
  const [inviting, setInviting] = useState(false);
  // A refused role change (e.g. the last admin) puts each Select back to the role the API has.
  const [attempt, setAttempt] = useState(0);

  if (!can("users.manage")) {
    return (
      <div className="page">
        <ErrorStrip error={new Error("Only admins can manage users and roles.")} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Users and roles"
        subtitle={`Who can sign in to ${me.account.name}, and what each of them may do there.`}
        actions={
          <Button design="Emphasized" icon="add" onClick={() => setInviting(true)}>
            Invite
          </Button>
        }
      />
      <ErrorStrip error={changeRole.error ?? remove.error ?? withdraw.error ?? team.error} />
      {team.isPending ? (
        <Loading />
      ) : (
        <>
          <section className="block">
            <Title level="H4">Members</Title>
            <Table
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell>Email</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Joined</TableHeaderCell>
                  <TableHeaderCell horizontalAlign="End">
                    <span className="sr-only">Actions</span>
                  </TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {team.data?.members.map((m) => (
                <TableRow key={m.userId} rowKey={m.userId}>
                  <TableCell>
                    {m.email}
                    {m.userId === me.user.id && <span className="muted you">(you)</span>}
                  </TableCell>
                  <TableCell>
                    <Select
                      key={`${m.role}-${attempt}`}
                      value={m.role}
                      accessibleName={`Role of ${m.email}`}
                      onChange={(e) =>
                        changeRole.mutate({ userId: m.userId, role: e.detail.selectedOption.value as Role }, { onSettled: () => setAttempt((n) => n + 1) })
                      }
                    >
                      {ROLES.map((r) => (
                        <Option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </Option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>{formatDateTime(m.joinedAt)}</TableCell>
                  <TableCell horizontalAlign="End">
                    <Button
                      design="Transparent"
                      icon="delete"
                      disabled={remove.isPending}
                      onClick={() => {
                        const who = m.userId === me.user.id ? "yourself" : m.email;
                        if (window.confirm(`Remove ${who} from ${me.account.name}? Their sign-in to this account ends at once.`)) remove.mutate(m.userId);
                      }}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </section>

          <section className="block">
            <Title level="H4">Open invitations</Title>
            <Table
              noDataText="No open invitations."
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell>Email</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Link valid until</TableHeaderCell>
                  <TableHeaderCell horizontalAlign="End">
                    <span className="sr-only">Actions</span>
                  </TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {team.data?.invitations.map((i) => (
                <TableRow key={i.id} rowKey={i.id}>
                  <TableCell>{i.email}</TableCell>
                  <TableCell>{ROLE_LABEL[i.role]}</TableCell>
                  <TableCell>{formatDateTime(i.expiresAt)}</TableCell>
                  <TableCell horizontalAlign="End">
                    <Button design="Transparent" disabled={withdraw.isPending} onClick={() => withdraw.mutate(i.id)}>
                      Withdraw
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </section>

          <section className="block">
            <Title level="H4">What each role can do</Title>
            <dl className="roles">
              {ROLES.map((r) => (
                <div key={r}>
                  <dt>{ROLE_LABEL[r]}</dt>
                  <dd>{ROLE_SUMMARY[r]}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  );
}

/** Creates an invitation and shows its link once: Ystara sends no email, the admin passes the link on. */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const invite = useInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [copied, setCopied] = useState(false);
  const link = invite.data && `${window.location.origin}/invite/${invite.data.token}`;

  return (
    <Dialog
      open
      headerText={link ? "Send this link" : "Invite someone"}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          {link ? (
            <Button design="Emphasized" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button design="Emphasized" disabled={!email.trim() || invite.isPending} onClick={() => invite.mutate({ email: email.trim(), role })}>
                Create invitation link
              </Button>
              <Button design="Transparent" onClick={onClose}>
                Cancel
              </Button>
            </>
          )}
        </div>
      }
    >
      {link ? (
        <div className="dialog-body">
          <p>
            Send this link to {invite.data!.invitation.email}. It works once, until {formatDateTime(invite.data!.invitation.expiresAt)}. There they
            choose a password and set up an authenticator app.
          </p>
          <div className="copy-row">
            <Input readonly value={link} className="mono" accessibleName="Invitation link" />
            <Button
              icon="copy"
              onClick={() =>
                void navigator.clipboard.writeText(link).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <MessageStrip design="Critical" hideCloseButton>
            Ystara shows this link only now. If it gets lost, withdraw the invitation and create a new one.
          </MessageStrip>
        </div>
      ) : (
        <div className="dialog-body">
          <Label for="invite-email" required>
            Email
          </Label>
          <Input id="invite-email" type="Email" value={email} onInput={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          <Label for="invite-role" required>
            Role
          </Label>
          <Select id="invite-role" value={role} onChange={(e) => setRole(e.detail.selectedOption.value as Role)}>
            {ROLES.map((r) => (
              <Option key={r} value={r}>
                {ROLE_LABEL[r]}
              </Option>
            ))}
          </Select>
          <span className="muted">{ROLE_SUMMARY[role]}</span>
          <ErrorStrip error={invite.error} />
        </div>
      )}
    </Dialog>
  );
}
