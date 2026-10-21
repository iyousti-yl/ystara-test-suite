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
import { useNavigate, useSearchParams } from "react-router";
import { readableSpaces } from "@ystara/shared";
import { useCan, useConnection, useScans, useStartScan, type ConnectionJson } from "../api";
import { ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { useAddressTenant } from "../tenantScope";
import { ScanScheduleSection } from "./Schedule";
import { parseSpaces } from "./TenantConnection";

/**
 * Discovery: the tenant's scan schedule, its scans, newest first (refreshed
 * while one runs), and Scan spaces. A scan opens its objects; from there an
 * output's pipeline. `?scan=1` (Home's next step) opens the scan dialog.
 */
export function DiscoveryPage() {
  const { tenantId, tenant } = useAddressTenant();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const scans = useScans(tenantId);
  const connection = useConnection(tenantId);
  const readable = connection.data ? readableSpaces(connection.data) : [];
  const canScan = can("discovery.run") && Boolean(tenant.data?.host);
  const scanning = params.get("scan") === "1" && canScan;
  const setScanning = (open: boolean) => setParams(open ? { scan: "1" } : {}, { replace: true });

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <ErrorStrip error={tenant.error} />;

  return (
    <div className="page">
      <PageHeader
        title="Discovery"
        subtitle="Each scan reads the object definitions of some spaces and works out how they feed each other. Open one to pick an output and see its pipeline."
        actions={
          can("discovery.run") && (
            <Button design="Emphasized" icon="refresh" disabled={!canScan} onClick={() => setScanning(true)}>
              Scan spaces
            </Button>
          )
        }
      />
      {!tenant.data.host && (
        <MessageStrip design="Information" hideCloseButton>
          This tenant has no Datasphere URL: it only has scans loaded with <span className="mono">npm run db:import</span>, so it can&apos;t be scanned from
          here.
        </MessageStrip>
      )}
      {tenant.data.host && (
        <ScanScheduleSection
          tenantId={tenantId}
          spaces={readable}
          whyNot={
            connection.isSuccess && !readable.length
              ? "Scheduled scans read the spaces the technical client can read, and it can't read any yet: see Connection › Technical client."
              : undefined
          }
        />
      )}
      <section className="block">
        <Title level="H4">Scans</Title>
        <ErrorStrip error={scans.error} />
        <Table
          loading={scans.isPending}
          noDataText="No scans yet."
          overflowMode="Popin"
          onRowClick={(e) => navigate(`/scans/${e.detail.row.rowKey}`)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="11rem" importance={1}>
                Requested
              </TableHeaderCell>
              <TableHeaderCell minWidth="8rem" importance={1}>
                Spaces
              </TableHeaderCell>
              <TableHeaderCell minWidth="7rem" importance={1}>
                Status
              </TableHeaderCell>
              <TableHeaderCell minWidth="5rem" horizontalAlign="End">
                Objects
              </TableHeaderCell>
              <TableHeaderCell minWidth="5rem" horizontalAlign="End">
                Links
              </TableHeaderCell>
              <TableHeaderCell minWidth="6rem" horizontalAlign="End">
                Warnings
              </TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {scans.data?.map((s) => (
            <TableRow key={s.id} rowKey={s.id} interactive>
              <TableCell>
                {formatDateTime(s.requestedAt)}
                {s.source === "import" && <span className="muted"> (imported)</span>}
                {s.scheduled && <span className="muted"> (scheduled)</span>}
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
      {scanning && <ScanDialog tenantId={tenantId} onClose={() => setScanning(false)} />}
    </div>
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
    return `${readOnly} This tenant is not connected: an admin connects it under Connection › Technical client, and until then the scan fails. (Only a worker started on a developer's computer with YSTARA_WORKER_MACHINE_LOGIN=1 scans it with that computer's own Datasphere CLI login.)`;
  }
  if (readable.length === 0) return `${readOnly} The technical client can't read any of its spaces yet: see Connection › Technical client.`;
  return `${readOnly} It logs in with the tenant's technical client, in the spaces its last check could read.`;
}
