import { Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow } from "@ui5/webcomponents-react";
import { useNavigate } from "react-router";
import { usePipelines } from "../api";
import { monoColumnWidth } from "../columns";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { useAddressTenant } from "../tenantScope";

/** Pipelines: the tenant's saved pipelines. One opens on its lineage, with its snapshots in the next tab. */
export function PipelinesPage() {
  const { tenantId, tenant } = useAddressTenant();
  const navigate = useNavigate();
  const pipelines = usePipelines(tenantId);

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <ErrorStrip error={tenant.error} />;

  return (
    <div className="page">
      <PageHeader title="Pipelines" subtitle="Saved pipelines, worked out again from each new scan. Open one for its lineage and its snapshots." />
      <ErrorStrip error={pipelines.error} />
      <Table
        loading={pipelines.isPending}
        noDataText="No saved pipelines yet. In Discovery, open a scan, pick an output and save its pipeline."
        overflowMode="Popin"
        onRowClick={(e) => navigate(`/pipelines/${e.detail.row.rowKey}`)}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="10rem" importance={1}>
              Name
            </TableHeaderCell>
            <TableHeaderCell minWidth={monoColumnWidth(pipelines.data?.map((p) => `${p.output.space}.${p.output.technicalName}`) ?? [])} importance={1}>
              Output
            </TableHeaderCell>
            {/* The writers wrap between names, but each one stays on one line. */}
            <TableHeaderCell minWidth={monoColumnWidth(pipelines.data?.flatMap((p) => p.excludeWriters) ?? [])}>Excluded writers</TableHeaderCell>
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
    </div>
  );
}
