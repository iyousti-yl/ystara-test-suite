import { useState, type ReactNode } from "react";
import { Button, Card, CardHeader, Dialog, Link, MessageStrip } from "@ui5/webcomponents-react";
import { useNavigate } from "react-router";
import { readableSpaces, type Permission } from "@ystara/shared";
import {
  useCan,
  useConnection,
  useDatabaseUsers,
  useDeleteTenant,
  usePipelines,
  useScans,
  type ConnectionJson,
  type DatabaseUserJson,
  type PipelineDefinitionJson,
  type ScanJson,
  type TenantJson,
} from "../api";
import { ConnectionStatusTag, ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { counted, formatDateTime } from "../format";
import { useAddressTenant } from "../tenantScope";

/**
 * Home: the picked tenant at a glance, one card per app (its technical
 * client, database users, scans and saved pipelines), and the one next step
 * that applies, from connecting it to saving a pipeline. Admins delete the
 * tenant from here. It shows what the apps' own calls return: nothing extra.
 */
export function TenantHomePage() {
  const { tenantId, tenant } = useAddressTenant();
  const navigate = useNavigate();
  const can = useCan();
  const connection = useConnection(tenantId);
  const users = useDatabaseUsers(tenantId);
  const scans = useScans(tenantId);
  const pipelines = usePipelines(tenantId);
  const [deleting, setDeleting] = useState(false);

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <ErrorStrip error={tenant.error} />;
  const t = tenant.data;
  const app = (path: string) => `/tenants/${tenantId}${path}`;
  const loaded = !connection.isPending && !users.isPending && !scans.isPending && !pipelines.isPending;
  const step = loaded ? nextStep(t, connection.data ?? null, users.data ?? [], scans.data ?? [], pipelines.data ?? [], can) : undefined;

  return (
    <div className="page">
      <PageHeader
        title={t.name}
        subtitle={t.host ?? "No Datasphere URL: this tenant only has imported scans."}
        actions={
          can("tenant.connect") && (
            <Button design="Transparent" icon="delete" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          )
        }
      />
      <ErrorStrip error={connection.error ?? users.error ?? scans.error ?? pipelines.error} />
      {step && (
        <MessageStrip design="Information" hideCloseButton>
          <div className="next-step">
            <span>{step.text}</span>
            <Button design="Emphasized" onClick={() => navigate(step.to)}>
              {step.button}
            </Button>
          </div>
        </MessageStrip>
      )}

      <div className="overview">
        {t.host && (
          <OverviewCard title="Technical client" subtitle="Connection" to={app("/connection")} loading={connection.isPending}>
            <ClientFacts connection={connection.data ?? null} />
          </OverviewCard>
        )}
        {t.host && (
          <OverviewCard title="Database users" subtitle="Connection" to={app("/database-users")} loading={users.isPending}>
            <UserFacts users={users.data ?? []} />
          </OverviewCard>
        )}
        <OverviewCard title="Discovery" subtitle={counted(scans.data?.length ?? 0, "scan")} to={app("/discovery")} loading={scans.isPending}>
          <ScanFacts scans={scans.data ?? []} />
        </OverviewCard>
        <OverviewCard title="Pipelines" subtitle={counted(pipelines.data?.length ?? 0, "saved pipeline")} to={app("/pipelines")} loading={pipelines.isPending}>
          <PipelineFacts pipelines={pipelines.data ?? []} />
        </OverviewCard>
      </div>

      {deleting && (
        <DeleteTenantDialog
          tenant={t}
          connection={connection.data ?? null}
          users={users.data ?? []}
          scans={scans.data?.length ?? 0}
          pipelines={pipelines.data?.length ?? 0}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

interface Step {
  text: string;
  button: string;
  to: string;
}

/**
 * The first thing missing on the way to a snapshot, in the order it is set up.
 * For someone whose role can't do it, the step says who does, and only opens the app.
 */
function nextStep(
  tenant: TenantJson,
  connection: ConnectionJson | null,
  users: DatabaseUserJson[],
  scans: ScanJson[],
  pipelines: PipelineDefinitionJson[],
  can: (permission: Permission) => boolean,
): Step | undefined {
  const admin = can("tenant.connect");
  const app = (path: string) => `/tenants/${tenant.id}${path}`;
  const scanned = scans.find((s) => s.status === "succeeded");
  if (tenant.host) {
    if (!connection) {
      return admin
        ? { text: "Connect this tenant with a technical OAuth client, so the worker can scan it.", button: "Connect", to: app("/connection?connect=1") }
        : {
            text: "This tenant is not connected yet. An admin connects it with a technical OAuth client.",
            button: "Open technical client",
            to: app("/connection"),
          };
    }
    if (connection.status === "checking") {
      return { text: "The worker is checking the technical client and the spaces it can read.", button: "Open technical client", to: app("/connection") };
    }
    if (readableSpaces(connection).length === 0) {
      return { text: "The technical client can't read any space yet.", button: "Open technical client", to: app("/connection") };
    }
    if (!scanned) {
      if (scans.some((s) => s.status === "queued" || s.status === "running")) {
        return { text: "A scan is running. Its objects show in Discovery once it is done.", button: "Open Discovery", to: app("/discovery") };
      }
      return can("discovery.run")
        ? { text: "Scan the spaces of one pipeline to see their objects and how they feed each other.", button: "Scan spaces", to: app("/discovery?scan=1") }
        : { text: "No scan has finished yet. A developer or an admin scans the spaces in Discovery.", button: "Open Discovery", to: app("/discovery") };
    }
  }
  if (scanned && pipelines.length === 0) {
    return can("pipelines.write")
      ? { text: "Open the latest scan, pick an output and save its pipeline.", button: "Open the latest scan", to: `/scans/${scanned.id}` }
      : {
          text: "No pipeline is saved yet. Open the latest scan to look at the pipeline behind any output.",
          button: "Open the latest scan",
          to: `/scans/${scanned.id}`,
        };
  }
  if (tenant.host && pipelines.length > 0 && users.length === 0) {
    return admin
      ? { text: "Add a database user, so snapshots can measure the data of the pipelines.", button: "Add database user", to: app("/database-users") }
      : { text: "Snapshots need a database user, which an admin adds.", button: "Open database users", to: app("/database-users") };
  }
  return undefined;
}

/** One app on Home: its header opens the app. */
function OverviewCard(props: { title: string; subtitle: string; to: string; loading: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Card
      className="overview-card"
      header={<CardHeader titleText={props.title} subtitleText={props.subtitle} interactive onClick={() => navigate(props.to)} />}
    >
      <div className="overview-body">{props.loading ? <Loading /> : props.children}</div>
    </Card>
  );
}

function ClientFacts({ connection: c }: { connection: ConnectionJson | null }) {
  if (!c) return <p className="muted">Not connected yet.</p>;
  const readable = readableSpaces(c);
  return (
    <ul className="overview-facts">
      <li>
        <ConnectionStatusTag status={c.status} />
      </li>
      <li>
        Client <span className="mono">{c.clientId}</span>
      </li>
      <li>{readable.length > 0 ? <>Reads {readable.join(", ")}</> : <span className="muted">Reads no space yet</span>}</li>
    </ul>
  );
}

function UserFacts({ users }: { users: DatabaseUserJson[] }) {
  if (users.length === 0) return <p className="muted">None yet: snapshots can&apos;t measure anything.</p>;
  return (
    <ul className="overview-facts">
      {users.map((u) => (
        <li key={u.space}>
          <span className="mono">{u.space}</span> <ConnectionStatusTag status={u.status} />
        </li>
      ))}
    </ul>
  );
}

function ScanFacts({ scans }: { scans: ScanJson[] }) {
  const latest = scans[0];
  if (!latest) return <p className="muted">No scans yet.</p>;
  return (
    <ul className="overview-facts">
      <li>
        Latest {formatDateTime(latest.requestedAt)} <ScanStatusTag status={latest.status} />
      </li>
      <li className="mono">{latest.spaces.join(", ")}</li>
      {latest.objectCount !== null && (
        <li>
          {latest.objectCount} objects, {latest.edgeCount} links
        </li>
      )}
    </ul>
  );
}

/** The first few by name; each opens its pipeline. */
function PipelineFacts({ pipelines }: { pipelines: PipelineDefinitionJson[] }) {
  const navigate = useNavigate();
  if (pipelines.length === 0) return <p className="muted">None saved yet.</p>;
  const shown = [...pipelines].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5);
  return (
    <ul className="overview-facts">
      {shown.map((p) => (
        <li key={p.id}>
          <Link
            href={`/pipelines/${p.id}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/pipelines/${p.id}`);
            }}
          >
            {p.name}
          </Link>
        </li>
      ))}
      {pipelines.length > shown.length && <li className="muted">and {pipelines.length - shown.length} more</li>}
    </ul>
  );
}

/**
 * Says what goes with the tenant before it is deleted: everything Ystara stored
 * for it, including the secrets it holds. Nothing in Datasphere.
 */
function DeleteTenantDialog(props: {
  tenant: TenantJson;
  connection: ConnectionJson | null;
  users: DatabaseUserJson[];
  scans: number;
  pipelines: number;
  onClose: () => void;
}) {
  const { tenant, connection, users, scans, pipelines, onClose } = props;
  const navigate = useNavigate();
  const remove = useDeleteTenant();
  const goes = [
    `${counted(scans, "scan")}, with the object definitions ${scans === 1 ? "it" : "they"} read`,
    `${counted(pipelines, "saved pipeline")}, with ${pipelines === 1 ? "its" : "all their"} snapshots`,
    connection && `the technical client ${connection.clientId}, with its stored secret`,
    users.length > 0 &&
      `${counted(users.length, "database user")}, with ${users.length === 1 ? "its" : "their"} stored password${users.length === 1 ? "" : "s"}`,
  ].filter((line): line is string => typeof line === "string");

  return (
    <Dialog
      open
      state="Negative"
      headerText={`Delete ${tenant.name}?`}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Negative" disabled={remove.isPending} onClick={() => remove.mutate(tenant.id, { onSuccess: () => navigate("/", { replace: true }) })}>
            Delete tenant
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>This removes the tenant from Ystara, with everything stored for it:</p>
        <ul className="deleted-with">
          {goes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <MessageStrip design="Information" hideCloseButton>
          Nothing is deleted or changed in the Datasphere tenant itself.
        </MessageStrip>
        <p className="muted">This can&apos;t be undone. To use the tenant again, add it, connect it and scan it again.</p>
        <ErrorStrip error={remove.error} />
      </div>
    </Dialog>
  );
}
