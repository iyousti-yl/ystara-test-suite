import { useRef, useState } from "react";
import {
  Button,
  Input,
  Label,
  MessageStrip,
  Option,
  Select,
  type SelectDomRef,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Title,
} from "@ui5/webcomponents-react";
import { ROLES, type Role, type SpaceScope } from "@ystara/shared";
import { useCan, useChangeRole, useInvite, useMe, useRemoveMember, useRenameAccount, useTeam, useTeamSpaces, useWithdrawInvitation, type TeamJson } from "../api";
import { Dialog } from "../components/Dialog";
import { ErrorStrip, Loading, When } from "../components/Feedback";
import { LinkToSend } from "../components/LinkToSend";
import { MoreActions } from "../components/MoreActions";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { RenameAccountDialog } from "../components/RenameAccountDialog";
import { SpacesPicker, spacesLabel } from "../components/SpacesPicker";
import { formatDateTime } from "../format";
import { ROLE_LABEL, ROLE_SUMMARY } from "../roles";

/**
 * The account's admin page (/users): who can sign in to this account, with
 * which role and in which spaces, and the invitations still open; the
 * account's name can be changed here too. Admins only; the API checks it too.
 */
export function UsersPage() {
  const can = useCan();
  const me = useMe().data!;
  const team = useTeam(can("users.manage"));
  const changeRole = useChangeRole();
  const remove = useRemoveMember();
  const withdraw = useWithdrawInvitation();
  const [inviting, setInviting] = useState(false);
  const [limiting, setLimiting] = useState<TeamJson["members"][number]>();
  const rename = useRenameAccount();
  const [renaming, setRenaming] = useState(false);
  const closeRename = () => {
    setRenaming(false);
    rename.reset();
  };
  // The role picked in a member's Select, waiting for the admin to confirm it, and that Select, to put back on Cancel.
  const [changing, setChanging] = useState<{ member: TeamJson["members"][number]; role: Role }>();
  const changedSelect = useRef<SelectDomRef>(null);
  const cancelChange = () => {
    if (changing && changedSelect.current) changedSelect.current.value = changing.member.role;
    setChanging(undefined);
    changeRole.reset();
  };

  if (!can("users.manage")) return <PageError heading="You can't open Users and roles" sentence="Only admins of the account manage its users and roles." />;

  return (
    <div className="page">
      <PageHeader
        title="Users and roles"
        subtitle={`Who can sign in to ${me.account.name}, and what each of them may do there.`}
        actions={
          <>
            <Button design="Emphasized" icon="add" onClick={() => setInviting(true)}>
              Invite
            </Button>
            <MoreActions actions={[can("account.manage") && { text: "Rename account", icon: "edit", onClick: () => setRenaming(true) }]} />
          </>
        }
      />
      <ErrorStrip error={remove.error ?? withdraw.error ?? team.error} />
      {team.isPending ? (
        <Loading />
      ) : (
        <>
          <section className="block">
            <Title level="H2" size="H4">Members</Title>
            <Table
              overflowMode="Popin"
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem" importance={1}>
                    Email
                  </TableHeaderCell>
                  <TableHeaderCell minWidth="10rem">Role</TableHeaderCell>
                  <TableHeaderCell minWidth="10rem">Spaces</TableHeaderCell>
                  <TableHeaderCell minWidth="10rem">Joined</TableHeaderCell>
                  <TableHeaderCell minWidth="6rem" importance={1} horizontalAlign="End">
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
                    {m.signInResets.length > 0 && <ResetNote resets={m.signInResets} />}
                  </TableCell>
                  <TableCell>
                    <Select
                      key={m.role}
                      value={m.role}
                      accessibleName={`Role of ${m.email}`}
                      onChange={(e) => {
                        changedSelect.current = e.target;
                        setChanging({ member: m, role: e.detail.selectedOption.value as Role });
                      }}
                    >
                      {ROLES.map((r) => (
                        <Option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </Option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    {m.role === "admin" ? (
                      <span className="muted">Every space, as an admin</span>
                    ) : (
                      <span className="spaces-cell">
                        <span className={m.spaces ? "mono" : undefined}>{spacesLabel(m.spaces)}</span>
                        <Button design="Transparent" icon="edit" tooltip={`Change the spaces ${m.email} sees`} accessibleName={`Change the spaces of ${m.email}`} onClick={() => setLimiting(m)} />
                      </span>
                    )}
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
            <Title level="H2" size="H4">Open invitations</Title>
            <Table
              noDataText="No open invitations."
              overflowMode="Popin"
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem" importance={1}>
                    Email
                  </TableHeaderCell>
                  <TableHeaderCell minWidth="7rem">Role</TableHeaderCell>
                  <TableHeaderCell minWidth="8rem">Spaces</TableHeaderCell>
                  <TableHeaderCell minWidth="10rem">Link valid until</TableHeaderCell>
                  <TableHeaderCell minWidth="6rem" importance={1} horizontalAlign="End">
                    <span className="sr-only">Actions</span>
                  </TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {team.data?.invitations.map((i) => (
                <TableRow key={i.id} rowKey={i.id}>
                  <TableCell>{i.email}</TableCell>
                  <TableCell>{ROLE_LABEL[i.role]}</TableCell>
                  <TableCell>
                    <span className={i.spaces ? "mono" : undefined}>{i.role === "admin" ? "Every space" : spacesLabel(i.spaces)}</span>
                  </TableCell>
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
            <Title level="H2" size="H4">What each role can do</Title>
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
      {limiting && <SpacesDialog member={limiting} onClose={() => setLimiting(undefined)} />}
      {changing && (
        <ChangeRoleDialog
          email={changing.member.email}
          from={changing.member.role}
          to={changing.role}
          yourself={changing.member.userId === me.user.id}
          pending={changeRole.isPending}
          error={changeRole.error}
          onChange={() => changeRole.mutate({ userId: changing.member.userId, role: changing.role }, { onSuccess: () => setChanging(undefined) })}
          onCancel={cancelChange}
        />
      )}
      {renaming && (
        <RenameAccountDialog
          current={me.account.name}
          pending={rename.isPending}
          error={rename.error}
          onRename={(name) => rename.mutate(name, { onSuccess: closeRename })}
          onClose={closeRename}
        />
      )}
    </div>
  );
}

/** Creates an invitation and shows its link once: Ystara sends no email, the admin passes the link on. */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const invite = useInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [spaces, setSpaces] = useState<SpaceScope | undefined>(null);
  const known = useTeamSpaces(true).data ?? [];

  return (
    <Dialog
      headerText={invite.data ? "Send this link" : "Invite someone"}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          {invite.data ? (
            <Button design="Emphasized" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                design="Emphasized"
                disabled={!email.trim() || (role !== "admin" && spaces === undefined) || invite.isPending}
                onClick={() => invite.mutate({ email: email.trim(), role, spaces: role === "admin" ? null : (spaces ?? null) })}
              >
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
      {invite.data ? (
        <LinkToSend
          path={`/invite/${invite.data.token}`}
          to={invite.data.invitation.email}
          until={invite.data.invitation.expiresAt}
          purpose="There they choose a password and set up an authenticator app."
        />
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
          {role !== "admin" && (
            <>
              <Label>Spaces</Label>
              <SpacesPicker id="invite-spaces" value={null} known={known} onChange={setSpaces} />
            </>
          )}
          <ErrorStrip error={invite.error} />
        </div>
      )}
    </Dialog>
  );
}

/** Every space, or only some, for a member other than an admin. Their sign-in sees the change at their next request. */
function SpacesDialog({ member, onClose }: { member: TeamJson["members"][number]; onClose: () => void }) {
  const change = useChangeRole();
  const known = useTeamSpaces(true).data;
  const [spaces, setSpaces] = useState<SpaceScope | undefined>(member.spaces);

  return (
    <Dialog
      headerText={`Spaces of ${member.email}`}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button
            design="Emphasized"
            disabled={spaces === undefined || change.isPending}
            onClick={() => change.mutate({ userId: member.userId, role: member.role, spaces: spaces ?? null }, { onSuccess: onClose })}
          >
            Save
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        {known ? <SpacesPicker id="member-spaces" value={member.spaces} known={[...new Set([...known, ...(member.spaces ?? [])])].sort()} onChange={setSpaces} /> : <Loading />}
        <ErrorStrip error={change.error} />
      </div>
    </Dialog>
  );
}

/**
 * The latest sign-in reset Ystara's operator made for a member, in one short line; every reset
 * of the last 30 days, with its times, on hover.
 */
function ResetNote({ resets }: { resets: TeamJson["members"][number]["signInResets"] }) {
  const [latest] = resets;
  const all = resets
    .map((r) =>
      r.usedAt
        ? `Sign-in reset by Ystara on ${formatDateTime(r.usedAt)} (link made ${formatDateTime(r.madeAt)})`
        : `Reset link made on ${formatDateTime(r.madeAt)}: ${r.open ? "not used yet" : "never used, no longer valid"}`,
    )
    .join("\n");
  return (
    <div className="muted" title={all}>
      {latest.usedAt ? (
        <>
          Sign-in reset by Ystara <When iso={latest.usedAt} />
        </>
      ) : latest.open ? (
        <>
          Reset link waiting, made <When iso={latest.madeAt} />
        </>
      ) : (
        "Reset link not used, no longer valid"
      )}
      {resets.length > 1 && ` (${resets.length} in 30 days)`}
    </div>
  );
}

/** What the new role allows, before it is given: it takes effect at once, on the member's next request. */
function ChangeRoleDialog(props: {
  email: string;
  from: Role;
  to: Role;
  yourself: boolean;
  pending: boolean;
  error: Error | null;
  onChange: () => void;
  onCancel: () => void;
}) {
  const who = props.yourself ? "your role" : `the role of ${props.email}`;
  return (
    <Dialog
      headerText={`Change ${who} to ${ROLE_LABEL[props.to]}?`}
      onClose={props.onCancel}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={props.pending} onClick={props.onChange}>
            Change role
          </Button>
          <Button design="Transparent" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>
          {ROLE_LABEL[props.from]} becomes {ROLE_LABEL[props.to]}: {ROLE_SUMMARY[props.to].charAt(0).toLowerCase() + ROLE_SUMMARY[props.to].slice(1)}
        </p>
        <p className="muted">It takes effect at once, in every browser {props.yourself ? "you are" : "they are"} signed in to.</p>
        {props.yourself && props.from === "admin" && (
          <MessageStrip design="Critical" hideCloseButton>
            You won&apos;t be able to manage users and roles here any more. Another admin can give the role back.
          </MessageStrip>
        )}
        <ErrorStrip error={props.error} />
      </div>
    </Dialog>
  );
}
