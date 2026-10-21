import { useState } from "react";
import { Button, Dialog, Input, Label, MessageStrip, Panel } from "@ui5/webcomponents-react";
import { DATABASE_HOST_HINT, databaseUserProblem, databaseUserSpace, isDatabaseHost } from "@ystara/shared";
import { useCan, useCheckDatabaseUser, useDatabaseUsers, useRemoveDatabaseUser, useSetDatabaseUser, type DatabaseUserJson } from "../api";
import { EmptyState } from "../components/EmptyState";
import { ConnectionStatusTag, ErrorStrip, Loading } from "../components/Feedback";
import { MoreActions } from "../components/MoreActions";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { useAddressTenant } from "../tenantScope";

/**
 * Connection › Database users: the users snapshots read each space with, one
 * per space, with read access only. Admins add, change and remove them; anyone
 * who can scan may check one again. The worker checks each one at once, and
 * this page refreshes until the verdict is in (SpaceDatabaseUser in packages/shared/src/api.ts).
 */
export function DatabaseUsersPage() {
  const { tenantId, tenant } = useAddressTenant();
  const can = useCan();
  const users = useDatabaseUsers(tenantId);
  const check = useCheckDatabaseUser(tenantId);
  const remove = useRemoveDatabaseUser(tenantId);
  const [editing, setEditing] = useState<DatabaseUserJson | "new">();

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <ErrorStrip error={tenant.error} />;
  const host = tenant.data.host;

  const confirmRemove = (u: DatabaseUserJson) => {
    if (window.confirm(`Remove the database user ${u.user}? Snapshots of ${u.space} stop until an admin adds one again. The user in Datasphere stays as it is.`)) {
      remove.mutate(u.space);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Database users"
        subtitle="Snapshots measure the data of a space with SQL, through a database user of that space with read access only."
        actions={
          host &&
          can("tenant.connect") &&
          !!users.data?.length && (
            <Button icon="add" onClick={() => setEditing("new")}>
              Add database user
            </Button>
          )
        }
      />
      {host ? (
        <p className="muted page-intro">Such a user sees only the views exposed for consumption, so those are the steps a snapshot can measure.</p>
      ) : (
        <MessageStrip design="Information" hideCloseButton>
          This tenant only has imported scans, so there is no database to read.
        </MessageStrip>
      )}
      <ErrorStrip error={users.error ?? check.error ?? remove.error} />
      {!host ? null : users.isPending ? (
        <Loading />
      ) : users.data?.length === 0 ? (
        <EmptyState
          icon="database"
          title="No database users yet"
          action={
            can("tenant.connect") && (
              <Button design="Emphasized" icon="add" onClick={() => setEditing("new")}>
                Add database user
              </Button>
            )
          }
        >
          {can("tenant.connect")
            ? "Add one for each space whose views snapshots should measure."
            : "An admin adds one for each space whose views snapshots should measure."}
        </EmptyState>
      ) : (
        <ul className="item-list">
          {users.data?.map((u) => (
            <li key={u.space}>
              <div className="facts connection-row">
                <span className="mono">{u.space}</span>
                <ConnectionStatusTag status={u.status} />
                <span>
                  User <span className="mono">{u.user}</span>
                </span>
                {u.visible && <span>{sees(u.visible)}</span>}
                {u.checkedAt && <span>Checked {formatDateTime(u.checkedAt)}</span>}
              </div>
              <UserVerdict user={u} />
              {u.visible && u.visible.length > 0 && (
                <Panel headerText={`What it sees (${u.visible.length})`} collapsed fixed={false} className="database-user-visible">
                  <ul className="mono">
                    {u.visible.map((o) => (
                      <li key={o.name}>{o.name}</li>
                    ))}
                  </ul>
                </Panel>
              )}
              <div className="page-header-actions connection-row">
                {can("tenant.connect") && (
                  <Button icon="edit" onClick={() => setEditing(u)}>
                    Change
                  </Button>
                )}
                {can("discovery.run") && (
                  <Button icon="refresh" disabled={u.status === "checking" || check.isPending} onClick={() => check.mutate(u.space)}>
                    Check again
                  </Button>
                )}
                <MoreActions
                  label={`More for ${u.user}`}
                  actions={[can("tenant.connect") && { text: "Remove database user", icon: "delete", disabled: remove.isPending, onClick: () => confirmRemove(u) }]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <DatabaseUserDialog
          tenantId={tenantId}
          current={editing === "new" ? null : editing}
          // The tenant has one database host: start from the one its other users have.
          suggestedHost={users.data?.[0]?.host ?? ""}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

/** "Sees 12 views", "Sees 12 views and 1 table". */
function sees(visible: NonNullable<DatabaseUserJson["visible"]>): string {
  const count = (type: "VIEW" | "TABLE", word: string) => {
    const n = visible.filter((o) => o.type === type).length;
    return n ? `${n} ${word}${n === 1 ? "" : "s"}` : undefined;
  };
  const parts = [count("VIEW", "view"), count("TABLE", "table")].filter(Boolean);
  return parts.length ? `Sees ${parts.join(" and ")}` : "Sees nothing yet";
}

function UserVerdict({ user: u }: { user: DatabaseUserJson }) {
  if (u.status === "checking") {
    return <p className="muted">The worker is signing in with this user and listing what it sees. This section refreshes on its own.</p>;
  }
  if (u.status === "failed") {
    return (
      <MessageStrip design="Negative" hideCloseButton className="block">
        The check failed, so snapshots can&apos;t use this user.
        {u.error && <pre className="cli-output">{u.error}</pre>}
      </MessageStrip>
    );
  }
  if (u.visible?.length === 0) {
    return (
      <MessageStrip design="Critical" hideCloseButton className="block">
        This user signs in but sees nothing in {u.space}: none of its views is exposed for consumption yet. A Datasphere modeler can switch on Expose for
        Consumption in a view&apos;s properties. Ystara never changes the tenant.
      </MessageStrip>
    );
  }
  return null;
}

/**
 * Adding or changing a space's database user: what to create in Datasphere,
 * then its host, name and password. The space is the part of the name before
 * #. The password is never shown again, so a change means entering it again.
 */
function DatabaseUserDialog(props: { tenantId: string; current: DatabaseUserJson | null; suggestedHost: string; onClose: () => void }) {
  const { tenantId, current, onClose } = props;
  const save = useSetDatabaseUser(tenantId);
  const [host, setHost] = useState(current?.host ?? props.suggestedHost);
  const [user, setUser] = useState(current?.user ?? "");
  const [password, setPassword] = useState("");
  const hostOk = isDatabaseHost(host.trim().toLowerCase());
  const userProblem = databaseUserProblem(user.trim());
  const ready = hostOk && !userProblem && password.trim();
  const submit = () => save.mutate({ host: host.trim(), user: user.trim(), password: password.trim() }, { onSuccess: onClose });

  return (
    <Dialog
      open
      headerText={current ? `Change the database user of ${current.space}` : "Add a database user"}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={!ready || save.isPending} onClick={submit}>
            Save and check
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>Ystara only runs SELECT statements. A space administrator creates a database user for it once:</p>
        <ol className="steps-to-do">
          <li>In Datasphere, open Space Management, then the space, Database Access, Database Users, and Create.</li>
          <li>Tick Enable Read Access (SQL) and leave Enable Write Access off: Ystara refuses a user that could change the space.</li>
          <li>The user&apos;s details show its name (SPACE#SUFFIX) and the host name, and let you ask for a password. Copy all three.</li>
        </ol>
        <Label for="database-host" required>
          Host name
        </Label>
        <Input
          id="database-host"
          className="full-width"
          value={host}
          onInput={(e) => setHost(e.target.value)}
          placeholder="<id>.hana.<region>.hanacloud.ondemand.com or <id>.hna1.…"
          valueState={host.trim() && !hostOk ? "Negative" : "None"}
          valueStateMessage={<div>{DATABASE_HOST_HINT}</div>}
        />
        <Label for="database-user" required>
          User name
        </Label>
        <Input
          id="database-user"
          className="full-width"
          value={user}
          onInput={(e) => setUser(e.target.value)}
          placeholder="SPACE#SUFFIX"
          valueState={user.trim() && userProblem ? "Negative" : "None"}
          valueStateMessage={<div>Database user names look like SPACE#SUFFIX.</div>}
        />
        {user.trim() && !userProblem && <span className="muted">For space {databaseUserSpace(user.trim())}</span>}
        <Label for="database-password" required>
          Password
        </Label>
        <Input
          id="database-password"
          className="full-width"
          type="Password"
          value={password}
          onInput={(e) => setPassword(e.target.value)}
          placeholder={current ? "Enter it again: Ystara never shows it" : undefined}
        />
        <span className="muted">
          Ystara stores the password encrypted, sends it only to this host to sign in, and never shows it again. The worker checks the user once as soon
          as you save: repeated failed sign-ins can lock it.
        </span>
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
