import { useState } from "react";
import { Button, Dialog, Input, Label, MessageStrip, Panel, Title } from "@ui5/webcomponents-react";
import { DATABASE_HOST_HINT, databaseUserProblem, databaseUserSpace, isDatabaseHost } from "@ystara/shared";
import { useCan, useCheckDatabaseUser, useDatabaseUsers, useRemoveDatabaseUser, useSetDatabaseUser, type DatabaseUserJson, type TenantJson } from "../api";
import { ConnectionStatusTag, ErrorStrip, Loading } from "../components/Feedback";
import { formatDateTime } from "../format";

/**
 * The database users snapshots read each space with: one per space, with read
 * access only. Admins add, change and remove them; anyone who can scan may
 * check one again. The worker checks each one at once, and this section
 * refreshes until the verdict is in (SpaceDatabaseUser in packages/shared/src/api.ts).
 */
export function DatabaseUsersSection({ tenant }: { tenant: TenantJson }) {
  const can = useCan();
  const users = useDatabaseUsers(tenant.id);
  const check = useCheckDatabaseUser(tenant.id);
  const remove = useRemoveDatabaseUser(tenant.id);
  const [editing, setEditing] = useState<DatabaseUserJson | "new">();

  const confirmRemove = (u: DatabaseUserJson) => {
    if (window.confirm(`Remove the database user ${u.user}? Snapshots of ${u.space} stop until an admin adds one again. The user in Datasphere stays as it is.`)) {
      remove.mutate(u.space);
    }
  };

  return (
    <section className="block">
      <Title level="H4">Database users for snapshots</Title>
      <p className="muted">
        Snapshots measure the data of a space with SQL, through a database user of that space with read access only. Such a user sees only the views
        exposed for consumption, so those are the steps a snapshot can measure.
      </p>
      <ErrorStrip error={users.error ?? check.error ?? remove.error} />
      {users.isPending ? (
        <Loading />
      ) : users.data?.length === 0 ? (
        <MessageStrip design="Information" hideCloseButton className="block">
          {can("tenant.connect")
            ? "No database user yet. Add one for each space whose views snapshots should measure."
            : "No database user yet. An admin adds one for each space whose views snapshots should measure."}
        </MessageStrip>
      ) : (
        <ul className="space-results">
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
                {can("tenant.connect") && (
                  <Button design="Transparent" icon="delete" disabled={remove.isPending} onClick={() => confirmRemove(u)}>
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {can("tenant.connect") && !users.isPending && (
        <div className="page-header-actions connection-row">
          <Button icon="add" onClick={() => setEditing("new")}>
            Add database user
          </Button>
        </div>
      )}
      {editing && (
        <DatabaseUserDialog
          tenantId={tenant.id}
          current={editing === "new" ? null : editing}
          // The tenant has one database host: start from the one its other users have.
          suggestedHost={users.data?.[0]?.host ?? ""}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
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
