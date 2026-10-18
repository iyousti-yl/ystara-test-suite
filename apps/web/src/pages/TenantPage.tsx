import { useState } from "react";
import {
  Button,
  Dialog,
  Input,
  Label,
  MessageStrip,
  MultiComboBox,
  MultiComboBoxItem,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Title,
} from "@ui5/webcomponents-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { readableSpaces } from "@ystara/shared";
import {
  useCan,
  useConnection,
  useDatabaseUsers,
  useDeleteTenant,
  usePipelines,
  useScans,
  useStartScan,
  useTenant,
  type ConnectionJson,
  type TenantJson,
} from "../api";
import { ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { counted, formatDateTime } from "../format";
import { DatabaseUsersSection } from "./DatabaseUsers";
import { ConnectionSection, parseSpaces } from "./TenantConnection";

/**
 * One tenant: how the worker logs in to it (its technical client, and the
 * database users snapshots read each space with), its scans (newest first, refreshed
 * while one runs) and its saved pipelines. `?connect=1` (after adding a
 * tenant) opens the Connect wizard. Admins can delete it from Ystara.
 */
export function TenantPage() {
  const { tenantId = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const tenant = useTenant(tenantId);
  const scans = useScans(tenantId);
  const pipelines = usePipelines(tenantId);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const connecting = params.get("connect") === "1" && can("tenant.connect");
  const setConnecting = (open: boolean) => setParams(open ? { connect: "1" } : {}, { replace: true });

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <ErrorStrip error={tenant.error} />;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Tenants", to: "/" }]}
        title={tenant.data.name}
        subtitle={tenant.data.host ?? "No Datasphere URL: this tenant only has imported scans."}
        actions={
          <>
            {can("discovery.run") && (
              <Button design="Emphasized" icon="refresh" disabled={!tenant.data.host} onClick={() => setScanning(true)}>
                Scan spaces
              </Button>
            )}
            {can("tenant.connect") && (
              <Button design="Transparent" icon="delete" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            )}
          </>
        }
      />

      {tenant.data.host && <ConnectionSection tenant={tenant.data} connecting={connecting} onConnecting={setConnecting} />}
      {tenant.data.host && <DatabaseUsersSection tenant={tenant.data} />}

      <section className="block">
        <Title level="H4">Scans</Title>
        <ErrorStrip error={scans.error} />
        <Table
          loading={scans.isPending}
          noDataText="No scans yet."
          onRowClick={(e) => navigate(`/scans/${e.detail.row.rowKey}`)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Requested</TableHeaderCell>
              <TableHeaderCell>Spaces</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell horizontalAlign="End">Objects</TableHeaderCell>
              <TableHeaderCell horizontalAlign="End">Links</TableHeaderCell>
              <TableHeaderCell horizontalAlign="End">Warnings</TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {scans.data?.map((s) => (
            <TableRow key={s.id} rowKey={s.id} interactive>
              <TableCell>
                {formatDateTime(s.requestedAt)}
                {s.source === "import" && <span className="muted"> (imported)</span>}
              </TableCell>
              <TableCell className="mono">{s.spaces.join(", ")}</TableCell>
              <TableCell>
                <ScanStatusTag status={s.status} />
              </TableCell>
              <TableCell horizontalAlign="End">{s.objectCount ?? "–"}</TableCell>
              <TableCell horizontalAlign="End">{s.edgeCount ?? "–"}</TableCell>
              <TableCell horizontalAlign="End">{s.warnings.length || "–"}</TableCell>
            </TableRow>
          ))}
        </Table>
      </section>

      <section className="block">
        <Title level="H4">Saved pipelines</Title>
        <ErrorStrip error={pipelines.error} />
        <Table
          loading={pipelines.isPending}
          noDataText="No saved pipelines. Open a scan, pick an output and save its pipeline."
          onRowClick={(e) => navigate(`/pipelines/${e.detail.row.rowKey}`)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Output</TableHeaderCell>
              <TableHeaderCell>Excluded writers</TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {pipelines.data?.map((p) => (
            <TableRow key={p.id} rowKey={p.id} interactive>
              <TableCell>{p.name}</TableCell>
              <TableCell className="mono">
                {p.output.space}.{p.output.technicalName}
              </TableCell>
              <TableCell className="mono">{p.excludeWriters.join(", ") || "–"}</TableCell>
            </TableRow>
          ))}
        </Table>
      </section>

      {scanning && <ScanDialog tenantId={tenantId} onClose={() => setScanning(false)} />}
      {deleting && (
        <DeleteTenantDialog tenant={tenant.data} scans={scans.data?.length ?? 0} pipelines={pipelines.data?.length ?? 0} onClose={() => setDeleting(false)} />
      )}
    </div>
  );
}

/**
 * Says what goes with the tenant before it is deleted: everything Ystara stored
 * for it, including the secrets it holds. Nothing in Datasphere.
 */
function DeleteTenantDialog({ tenant, scans, pipelines, onClose }: { tenant: TenantJson; scans: number; pipelines: number; onClose: () => void }) {
  const navigate = useNavigate();
  const remove = useDeleteTenant();
  const connection = useConnection(tenant.id).data ?? null;
  const users = useDatabaseUsers(tenant.id).data ?? [];
  const goes = [
    `${counted(scans, "scan")}, with the object definitions ${scans === 1 ? "it" : "they"} read`,
    `${counted(pipelines, "saved pipeline")}, with ${pipelines === 1 ? "its" : "all their"} snapshots`,
    connection && `the technical client ${connection.clientId}, with its stored secret`,
    users.length > 0 && `${counted(users.length, "database user")}, with ${users.length === 1 ? "its" : "their"} stored password${users.length === 1 ? "" : "s"}`,
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

/**
 * Picks the spaces to scan: for a connected tenant, from the spaces its
 * technical client could read at the last check (the API refuses any other);
 * typed in for a tenant without a client (only a worker started with
 * YSTARA_WORKER_MACHINE_LOGIN=1 can scan it, with its machine's own CLI login).
 */
function ScanDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const start = useStartScan(tenantId);
  const connection = useConnection(tenantId).data ?? null;
  const readable = connection ? readableSpaces(connection) : [];
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const spaces = connection ? picked : parseSpaces(text);

  return (
    <Dialog
      open
      headerText="Scan spaces"
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={spaces.length === 0 || start.isPending} onClick={() => start.mutate(spaces, { onSuccess: onClose })}>
            Start scan
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        {connection ? (
          readable.length > 0 && (
            <>
              <Label for="spaces" required>
                Spaces
              </Label>
              <MultiComboBox
                id="spaces"
                className="full-width"
                placeholder="Choose the spaces of one pipeline"
                onSelectionChange={(e) => setPicked(e.detail.items.map((item) => item.text ?? "").filter(Boolean))}
              >
                {readable.map((space) => (
                  <MultiComboBoxItem key={space} text={space} selected={picked.includes(space)} />
                ))}
              </MultiComboBox>
            </>
          )
        ) : (
          <>
            <Label for="spaces" required>
              Space IDs
            </Label>
            <Input id="spaces" className="full-width" value={text} onInput={(e) => setText(e.target.value)} placeholder="HR, SHARED" />
          </>
        )}
        <MessageStrip design={readable.length ? "Information" : "Critical"} hideCloseButton>
          {scanLogin(connection, readable)} Scan the spaces of one pipeline together to see the links between them.
        </MessageStrip>
        <ErrorStrip error={start.error} />
      </div>
    </Dialog>
  );
}

function scanLogin(connection: ConnectionJson | null, readable: string[]): string {
  const readOnly = "Read-only: the worker lists and reads object definitions, nothing else.";
  if (!connection) {
    return `${readOnly} This tenant is not connected: an admin connects it on the tenant page, and until then the scan fails. (Only a worker started on a developer's computer with YSTARA_WORKER_MACHINE_LOGIN=1 scans it with that computer's own Datasphere CLI login.)`;
  }
  if (readable.length === 0) return `${readOnly} The technical client can't read any of its spaces yet: see Connection on the tenant page.`;
  return `${readOnly} It logs in with the tenant's technical client, in the spaces its last check could read.`;
}
