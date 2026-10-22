import { useState, type ReactNode } from "react";
import { Button, Card, CardHeader, Dialog, Icon, Link, MessageStrip, Title } from "@ui5/webcomponents-react";
import { useNavigate } from "react-router";
import { HEALTH_LABEL, HEALTH_STATES, readableSpaces, type Permission, type PipelineHealth } from "@ystara/shared";
import {
  useCan,
  useConnection,
  useDatabaseUsers,
  useDeleteTenant,
  usePipelines,
  usePipelineSummaries,
  useScans,
  type ConnectionJson,
  type DatabaseUserJson,
  type PipelineDefinitionJson,
  type PipelineSummaryJson,
  type ScanJson,
  type TenantJson,
} from "../api";
import { ConnectionStatusTag, ErrorStrip, HealthTag, Loading, ScanStatusTag } from "../components/Feedback";
import { healthOf, NextStep } from "../components/Health";
import { MoreActions } from "../components/MoreActions";
import { PageHeader } from "../components/PageHeader";
import { ShortId } from "../components/ShortId";
import { counted, formatDateTime } from "../format";
import { useAddressTenant } from "../tenantScope";

/**
 * Home: the picked tenant at a glance. Until it is set up, a checklist from
 * adding it to its first test, with one button for the step that comes next;
 * then what its pipelines' latest results say, problems first. Below, one card
 * per app (its technical client, database users, scans and saved pipelines).
 * Admins delete the tenant from here. It shows what the apps' own calls
 * return: nothing extra.
 */
export function TenantHomePage() {
  const { tenantId, tenant } = useAddressTenant();
  const can = useCan();
  const connection = useConnection(tenantId);
  const users = useDatabaseUsers(tenantId);
  const scans = useScans(tenantId);
  const pipelines = usePipelines(tenantId);
  const summaries = usePipelineSummaries(tenantId);
  const [deleting, setDeleting] = useState(false);

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <ErrorStrip error={tenant.error} />;
  const t = tenant.data;
  const app = (path: string) => `/tenants/${tenantId}${path}`;
  const loaded = !connection.isPending && !users.isPending && !scans.isPending && !pipelines.isPending && !summaries.isPending;
  const steps = loaded ? setupSteps(t, connection.data ?? null, users.data ?? [], scans.data ?? [], pipelines.data ?? [], summaries.data ?? [], can) : [];
  const health = (pipelines.data ?? [])
    .map((p) => ({ pipeline: p, summary: summaries.data?.find((s) => s.pipelineId === p.id) }))
    .flatMap(({ pipeline, summary }) => (summary ? [{ pipeline, health: healthOf(summary) }] : []))
    .sort((a, b) => HEALTH_STATES.indexOf(a.health.state) - HEALTH_STATES.indexOf(b.health.state) || a.pipeline.name.localeCompare(b.pipeline.name));

  return (
    <div className="page">
      <PageHeader
        title={t.name}
        subtitle={t.host ?? "Imported scans only: this tenant has no Datasphere URL to scan from."}
        actions={<MoreActions actions={[can("tenant.connect") && { text: "Delete tenant", icon: "delete", onClick: () => setDeleting(true) }]} />}
      />
      <ErrorStrip error={connection.error ?? users.error ?? scans.error ?? pipelines.error ?? summaries.error} />
      {steps.some((s) => !s.done) ? <SetupChecklist steps={steps} /> : loaded && health.length > 0 && <HealthSummary tenantId={tenantId} rows={health} />}

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
          <PipelineFacts pipelines={pipelines.data ?? []} health={health} />
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

interface SetupStep {
  label: string;
  done: boolean;
  /** For the first step not done: what it takes, and the button that gets there. */
  action?: Step;
}

/**
 * The way from adding a tenant to its first test, in the order it is set up:
 * connect it, scan it, save a pipeline, add a database user, test. A tenant of
 * imported scans only stops at the pipeline: nothing can read its data.
 * For someone whose role can't do the next step, it says who does, and only opens the app.
 */
function setupSteps(
  tenant: TenantJson,
  connection: ConnectionJson | null,
  users: DatabaseUserJson[],
  scans: ScanJson[],
  pipelines: PipelineDefinitionJson[],
  summaries: PipelineSummaryJson[],
  can: (permission: Permission) => boolean,
): SetupStep[] {
  const admin = can("tenant.connect");
  const app = (path: string) => `/tenants/${tenant.id}${path}`;
  const scanned = scans.find((s) => s.status === "succeeded");
  const scanning = scans.some((s) => s.status === "queued" || s.status === "running");
  const reads = connection !== null && readableSpaces(connection).length > 0;
  const tested = summaries.some((s) => s.snapshot?.status === "succeeded" || s.suite?.status === "passed" || s.suite?.status === "failed");
  const first = [...pipelines].sort((a, b) => a.name.localeCompare(b.name))[0];

  const connect: Step = !connection
    ? admin
      ? { text: "Give Ystara a technical OAuth client of the tenant: it reads the spaces' objects, never changes them.", button: "Connect", to: app("/connection?connect=1") }
      : { text: "An admin connects it with a technical OAuth client.", button: "Open technical client", to: app("/connection") }
    : connection.status === "checking"
      ? { text: "The worker is checking the technical client and the spaces it can read.", button: "Open technical client", to: app("/connection") }
      : { text: "The technical client can't read any space yet.", button: "Open technical client", to: app("/connection") };
  const scan: Step = scanning
    ? { text: "A scan is running. Its objects show in Discovery once it is done.", button: "Open Discovery", to: app("/discovery") }
    : can("discovery.run") && tenant.host
      ? { text: "Read the objects of the spaces one pipeline runs through, and how they feed each other.", button: "Scan spaces", to: app("/discovery?scan=1") }
      : { text: tenant.host ? "A developer or an admin scans the spaces in Discovery." : "Import a saved scan with npm run db:import.", button: "Open Discovery", to: app("/discovery") };
  const pipeline: Step = can("pipelines.write")
    ? { text: "Pick the output people use (a view or table) on the latest scan and save everything that feeds it.", button: "Pick an output", to: scanned ? `/scans/${scanned.id}` : app("/discovery") }
    : { text: "A developer saves one. Meanwhile, open the latest scan to look at the pipeline behind any output.", button: "Open the latest scan", to: scanned ? `/scans/${scanned.id}` : app("/discovery") };
  const databaseUser: Step = admin
    ? { text: "Snapshots and scenarios read data with SELECT through a database user of the output's space.", button: "Add database user", to: app("/database-users") }
    : { text: "Snapshots and scenarios read data through a database user, which an admin adds.", button: "Open database users", to: app("/database-users") };
  const test: Step = can("runs.execute")
    ? { text: "Take a snapshot to measure the real data, or write a scenario that checks the logic on test rows.", button: first ? `Open ${first.name}` : "Open Pipelines", to: first ? `/pipelines/${first.id}/snapshots` : app("/pipelines") }
    : { text: "A developer or test coordinator takes a snapshot or runs a scenario.", button: "Open Pipelines", to: app("/pipelines") };

  const steps: (Omit<SetupStep, "action"> & { action: Step })[] = [
    { label: "Add the tenant", done: true, action: connect },
    ...(tenant.host ? [{ label: "Connect a technical client", done: reads, action: connect }] : []),
    { label: tenant.host ? "Scan its spaces" : "Import a scan", done: scanned !== undefined, action: scan },
    { label: "Save a pipeline", done: pipelines.length > 0, action: pipeline },
    ...(tenant.host
      ? [
          { label: "Add a database user", done: users.some((u) => u.status === "connected"), action: databaseUser },
          { label: "Take a first snapshot or run a scenario", done: tested, action: test },
        ]
      : []),
  ];
  const next = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({ label: s.label, done: s.done, action: i === next ? s.action : undefined }));
}

function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const navigate = useNavigate();
  const done = steps.filter((s) => s.done).length;
  return (
    <section className="block setup" aria-label="Setting up this tenant">
      <div className="setup-head">
        <Title level="H2" size="H4">
          Set up this tenant
        </Title>
        <span className="muted">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="setup-steps">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? "is-done" : s.action ? "is-next" : undefined}>
            <Icon name={s.done ? "sys-enter-2" : s.action ? "navigation-right-arrow" : "circle-task"} accessibleName={s.done ? "Done" : s.action ? "Next" : "To do"} />
            <div className="setup-step">
              <span className="setup-label">{s.label}</span>
              {s.action && (
                <div className="setup-action">
                  <span className="muted">{s.action.text}</span>
                  <Button design="Emphasized" onClick={() => navigate(s.action!.to)}>
                    {s.action.button}
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Once set up: how many pipelines are in each state, and those that need a look, each with its next step. */
function HealthSummary({ tenantId, rows }: { tenantId: string; rows: { pipeline: PipelineDefinitionJson; health: PipelineHealth }[] }) {
  const navigate = useNavigate();
  const problems = rows.filter((r) => r.health.state === "failing" || r.health.state === "changed");
  const counts = HEALTH_STATES.map((state) => [state, rows.filter((r) => r.health.state === state).length] as const).filter(([, n]) => n > 0);
  return (
    <section className="block setup" aria-label="Pipelines at a glance">
      <div className="setup-head">
        <Title level="H2" size="H4">
          {problems.length === 0 ? "Nothing needs a look" : `${problems.length} ${problems.length === 1 ? "pipeline needs" : "pipelines need"} a look`}
        </Title>
        <span className="muted">{counts.map(([state, n]) => `${n} ${HEALTH_LABEL[state].toLowerCase()}`).join(" · ")}</span>
        <Link
          href={`/tenants/${tenantId}/pipelines`}
          onClick={(e) => {
            e.preventDefault();
            navigate(`/tenants/${tenantId}/pipelines`);
          }}
        >
          All pipelines
        </Link>
      </div>
      {problems.length > 0 && (
        <ul className="setup-steps">
          {problems.map(({ pipeline, health }) => (
            <li key={pipeline.id}>
              <HealthTag state={health.state} />
              <div className="setup-problem">
                <Link
                  href={`/pipelines/${pipeline.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/pipelines/${pipeline.id}`);
                  }}
                >
                  {pipeline.name}
                </Link>
                <span className="muted">{health.sentence}</span>
                <NextStep pipelineId={pipeline.id} next={health.next} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
        Client <ShortId id={c.clientId} what="client ID" />
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

/** The first few, problems first; each opens its pipeline. */
function PipelineFacts({ pipelines, health }: { pipelines: PipelineDefinitionJson[]; health: { pipeline: PipelineDefinitionJson; health: PipelineHealth }[] }) {
  const navigate = useNavigate();
  if (pipelines.length === 0) return <p className="muted">None saved yet.</p>;
  const ordered = health.length === pipelines.length ? health : [...pipelines].sort((a, b) => a.name.localeCompare(b.name)).map((pipeline) => ({ pipeline, health: undefined }));
  const shown = ordered.slice(0, 5);
  return (
    <ul className="overview-facts">
      {shown.map(({ pipeline: p, health: h }) => (
        <li key={p.id}>
          <Link
            href={`/pipelines/${p.id}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/pipelines/${p.id}`);
            }}
          >
            {p.name}
          </Link>{" "}
          {h && <HealthTag state={h.state} />}
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
