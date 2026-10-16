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
import { useCan, useConnection, usePipelines, useScans, useStartScan, useTenant, type ConnectionJson } from "../api";
import { ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { ConnectionSection } from "./TenantConnection";

/**
 * One tenant: how the worker logs in to it, its scans (newest first, refreshed
 * while one runs) and its saved pipelines. `?connect=1` (after adding a
 * tenant) opens the Connect wizard.
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
          can("discovery.run") && (
            <Button design="Emphasized" icon="refresh" disabled={!tenant.data.host} onClick={() => setScanning(true)}>
              Scan spaces
            </Button>
          )
        }
      />

      {tenant.data.host && <ConnectionSection tenant={tenant.data} connecting={connecting} onConnecting={setConnecting} />}

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
    </div>
  );
}

/** Space IDs, separated by commas or spaces, as the API expects them. */
export const parseSpaces = (text: string) => [...new Set(text.split(/[\s,;]+/).filter(Boolean).map((s) => s.toUpperCase()))];

/**
 * Picks the spaces to scan: from the spaces the technical client saw at its
 * last check, or typed in when the tenant has none (the machine's own CLI login).
 */
function ScanDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const start = useStartScan(tenantId);
  const connection = useConnection(tenantId).data ?? null;
  const visible = connection?.spaces ?? [];
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const spaces = visible.length ? picked : parseSpaces(text);

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
        <Label for="spaces" required>
          {visible.length ? "Spaces" : "Space IDs"}
        </Label>
        {visible.length ? (
          <MultiComboBox
            id="spaces"
            className="full-width"
            placeholder="Choose the spaces of one pipeline"
            onSelectionChange={(e) => setPicked(e.detail.items.map((item) => item.text ?? "").filter(Boolean))}
          >
            {visible.map((space) => (
              <MultiComboBoxItem key={space} text={space} selected={picked.includes(space)} />
            ))}
          </MultiComboBox>
        ) : (
          <Input id="spaces" className="full-width" value={text} onInput={(e) => setText(e.target.value)} placeholder="HR, SHARED" />
        )}
        <MessageStrip design={connection?.status === "failed" ? "Critical" : "Information"} hideCloseButton>
          {scanLogin(connection)} Scan the spaces of one pipeline together to see the links between them.
        </MessageStrip>
        <ErrorStrip error={start.error} />
      </div>
    </Dialog>
  );
}

function scanLogin(connection: ConnectionJson | null): string {
  const readOnly = "Read-only: the worker lists and reads object definitions, nothing else.";
  if (!connection) {
    return `${readOnly} This tenant has no technical client, so the worker uses the Datasphere CLI login of the machine it runs on (datasphere login, then npm run dev:worker).`;
  }
  if (connection.status === "failed") return `${readOnly} The technical client's last check failed, so this scan will probably fail too.`;
  return `${readOnly} It logs in with the tenant's technical client.`;
}
