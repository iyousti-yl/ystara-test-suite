import { useState } from "react";
import {
  Button,
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
import { readableSpaces, seesSpace } from "@ystara/shared";
import { useCan, useConnection, useMe, useScans, useStartScan, type ConnectionJson } from "../api";
import { Dialog } from "../components/Dialog";
import { ErrorStrip, Loading, ScanStatusTag, ShowOlder } from "../components/Feedback";
import { QuietNote } from "../components/Info";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { SpacesNote } from "../components/SpacesPicker";
import { spaceIdsOf } from "../fields";
import { countedLatest, formatDateTime, formatNumber } from "../format";
import { useAddressTenant } from "../tenantScope";
import { ScanScheduleSection } from "./Schedule";

/**
 * Discovery: the tenant's scan schedule, its scans, newest first, the latest
 * 50 and older ones on request (refreshed while one runs), and Scan spaces. A scan opens its objects; from there an
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
  if (!tenant.data) return <PageError error={tenant.error} what="tenant" />;

  return (
    <div className="page">
      <PageHeader
        title="Discovery"
        subtitle="Scans read the definitions of some spaces and work out how they feed each other. Open one to pick an output."
        actions={
          can("discovery.run") && (
            <Button design="Emphasized" icon="refresh" disabled={!canScan} onClick={() => setScanning(true)}>
              Scan spaces
            </Button>
          )
        }
      />
      <SpacesNote what="a scan shows you only the objects of these spaces, and you scan only these." />
      {!tenant.data.host && (
        <QuietNote more="To scan a tenant from here, add it with its Datasphere URL under Tenants." moreLabel="How to scan a tenant">
          This tenant only has imported scans.
        </QuietNote>
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
        <Title level="H2" size="H4">{scans.data && scans.hasNextPage ? countedLatest(scans.data.length, true, "scan") : "Scans"}</Title>
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
              <TableCell horizontalAlign="End" className="mono">{formatNumber(s.objectCount)}</TableCell>
              <TableCell horizontalAlign="End" className="mono">{formatNumber(s.edgeCount)}</TableCell>
              <TableCell horizontalAlign="End" className="mono">{s.warnings.length ? formatNumber(s.warnings.length) : "–"}</TableCell>
            </TableRow>
          ))}
        </Table>
        <ShowOlder list={scans} what="scans" />
      </section>
      {scanning && <ScanDialog tenantId={tenantId} onClose={() => setScanning(false)} />}
    </div>
  );
}

/**
 * Picks the spaces to scan: for a connected tenant, from the spaces its
 * technical client could read at the last check (the API refuses any other);
 * typed in for a tenant without a client (only a worker started with
 * YSTARA_WORKER_MACHINE_LOGIN=1 can scan it, with its machine's own CLI login;
 * the README says how, the dialog doesn't).
 */
function ScanDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const start = useStartScan(tenantId);
  const connection = useConnection(tenantId).data ?? null;
  // A member limited to some spaces scans only those (the API refuses the others).
  const mine = useMe().data?.spaces ?? null;
  const readable = (connection ? readableSpaces(connection) : []).filter((s) => seesSpace(mine, s));
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const typed = spaceIdsOf(text);
  const spaces = connection ? picked : typed.problem ? [] : typed.spaces;

  return (
    <Dialog
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
            <Input
              id="spaces"
              className="full-width"
              value={text}
              onInput={(e) => setText(e.target.value)}
              placeholder="HR, SHARED"
              valueState={text.trim() && typed.problem ? "Negative" : "None"}
              valueStateMessage={<div>{typed.problem}</div>}
            />
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
    return `${readOnly} This tenant is not connected yet: an admin connects it under Connection › Technical client, and until then a scan fails.`;
  }
  if (readable.length === 0) return `${readOnly} The technical client can't read any of its spaces yet: see Connection › Technical client.`;
  return `${readOnly} It logs in with the tenant's technical client, in the spaces its last check could read.`;
}
