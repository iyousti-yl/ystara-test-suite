import { MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Title } from "@ui5/webcomponents-react";
import type { ColumnMeasures, SnapshotObject } from "@ystara/shared";
import { useNavigate, useParams } from "react-router";
import { useSnapshot, useSnapshots, useTenant, type SnapshotJson } from "../api";
import { ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime, formatNumber } from "../format";
import { notMeasurableLabel } from "../lineage/model";
import { typeLabel } from "../objectTypes";

/** A saved pipeline's snapshots, newest first; refreshed while one is taken. */
export function SnapshotsSection({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const snapshots = useSnapshots(pipelineId);
  return (
    <section className="block">
      <Title level="H4">Snapshots</Title>
      <ErrorStrip error={snapshots.error} />
      <Table
        loading={snapshots.isPending}
        noDataText="No snapshots yet. Take one to measure the steps the database users can see."
        overflowMode="Popin"
        onRowClick={(e) => navigate(`/snapshots/${e.detail.row.rowKey}`)}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="11rem" importance={1}>
              Taken
            </TableHeaderCell>
            <TableHeaderCell minWidth="8rem" importance={1}>
              Status
            </TableHeaderCell>
            <TableHeaderCell minWidth="6rem" horizontalAlign="End">
              Measured
            </TableHeaderCell>
            <TableHeaderCell minWidth="8rem" horizontalAlign="End">
              Not measurable
            </TableHeaderCell>
            <TableHeaderCell minWidth="5rem" horizontalAlign="End">
              Failed
            </TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {snapshots.data?.map((s) => (
          <TableRow key={s.id} rowKey={s.id} interactive>
            <TableCell>{formatDateTime(s.finishedAt ?? s.requestedAt)}</TableCell>
            <TableCell>
              <ScanStatusTag status={s.status} />
            </TableCell>
            <TableCell horizontalAlign="End">{s.counts.measured}</TableCell>
            <TableCell horizontalAlign="End">{s.counts.notMeasurable}</TableCell>
            <TableCell horizontalAlign="End">{s.counts.failed || "–"}</TableCell>
          </TableRow>
        ))}
      </Table>
    </section>
  );
}

/**
 * One snapshot: the measures of each measured step, then every step of the
 * pipeline in order with what happened to it. Min and max (and a sum on a
 * small object) are shown as the start of their hash: Ystara never stores the
 * value, and two snapshots are compared by these.
 */
export function SnapshotPage() {
  const { snapshotId = "" } = useParams();
  const snapshot = useSnapshot(snapshotId);
  const tenant = useTenant(snapshot.data?.tenantId ?? "");

  if (snapshot.isPending) return <Loading />;
  if (!snapshot.data) return <ErrorStrip error={snapshot.error} />;
  const s = snapshot.data;
  const measured = s.objects.filter((o) => o.status === "measured");

  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { label: "Tenants", to: "/" },
          { label: tenant.data?.name ?? "Tenant", to: `/tenants/${s.tenantId}` },
          { label: s.pipelineName, to: `/pipelines/${s.pipelineId}` },
        ]}
        title={`Snapshot of ${formatDateTime(s.finishedAt ?? s.requestedAt)}`}
        subtitle={
          <span className="facts">
            <ScanStatusTag status={s.status} />
            <Counts snapshot={s} />
          </span>
        }
      />
      {s.error && (
        <MessageStrip design="Negative" hideCloseButton className="block">
          {s.error}
        </MessageStrip>
      )}
      {(s.status === "queued" || s.status === "running") && (
        <p className="muted">The worker is measuring the steps the database users can see. This page refreshes on its own.</p>
      )}

      {measured.length > 0 && (
        <MessageStrip design="Information" hideCloseButton className="block">
          Min and max are stored only as a fingerprint, a hash made with this tenant&apos;s secret in its own database, never as the value. So is the sum
          of an object with fewer than 10 rows. Equal fingerprints mean equal values, which is what a comparison of two snapshots needs.
        </MessageStrip>
      )}
      {measured.map((o) => (
        <section className="block" key={`${o.space}.${o.technicalName}`}>
          <Title level="H4">
            <span className="mono">{o.technicalName}</span>
          </Title>
          <p className="muted">
            {typeLabel(o.type)}: {formatNumber(o.rows)} rows, {o.columns?.length ?? 0} columns, measured in {((o.tookMs ?? 0) / 1000).toFixed(1)} s
          </p>
          <ColumnsTable columns={o.columns ?? []} />
        </section>
      ))}
      <section className="block">
        <Title level="H4">Every step</Title>
        <Table
          overflowMode="Popin"
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="10rem" importance={1}>
                Step
              </TableHeaderCell>
              <TableHeaderCell minWidth="10rem">Result</TableHeaderCell>
            </TableHeaderRow>
          }
          noDataText="No step measured yet."
        >
          {s.objects.map((o) => (
            <TableRow key={`${o.space}.${o.technicalName}`} rowKey={`${o.space}.${o.technicalName}`}>
              <TableCell>
                <span>
                  <span className="mono">{o.technicalName}</span> <span className="muted">{typeLabel(o.type)}</span>
                </span>
              </TableCell>
              <TableCell>
                <StepResult object={o} />
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </section>
    </div>
  );
}

function Counts({ snapshot: s }: { snapshot: SnapshotJson }) {
  const total = s.counts.measured + s.counts.notMeasurable + s.counts.failed;
  if (!total) return null;
  return (
    <span>
      {s.counts.measured} of {total} steps measured{s.counts.failed ? `, ${s.counts.failed} failed` : ""}
    </span>
  );
}

/** Measured, why not (as on the pipeline page, where each step's details say more), or why it failed. */
function StepResult({ object: o }: { object: SnapshotObject }) {
  if (o.status === "measured") return <span>Measured: {formatNumber(o.rows)} rows</span>;
  if (o.status === "failed") return <span className="text-negative">Failed: {o.reason}</span>;
  return <span className="muted">{notMeasurableLabel(o.reason as Parameters<typeof notMeasurableLabel>[0])}</span>;
}

/** The start of a hash, enough to see whether two differ. */
const fingerprint = (hash: string | null | undefined) => (hash ? `${hash.slice(0, 8)}…` : "–");

/** On a narrow screen the type goes under the column name first, then the measures from the right. */
function ColumnsTable({ columns }: { columns: ColumnMeasures[] }) {
  return (
    <Table
      overflowMode="Popin"
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell minWidth="9rem" importance={2}>
            Column
          </TableHeaderCell>
          <TableHeaderCell minWidth="7rem" importance={-1}>
            Type
          </TableHeaderCell>
          <TableHeaderCell minWidth="6rem" horizontalAlign="End" importance={1}>
            Non-null
          </TableHeaderCell>
          <TableHeaderCell minWidth="6rem" horizontalAlign="End" importance={1}>
            Distinct
          </TableHeaderCell>
          <TableHeaderCell minWidth="7rem" horizontalAlign="End">
            Min
          </TableHeaderCell>
          <TableHeaderCell minWidth="7rem" horizontalAlign="End">
            Max
          </TableHeaderCell>
          <TableHeaderCell minWidth="7rem" horizontalAlign="End">
            Sum
          </TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {columns.map((c) => (
        <TableRow key={c.name} rowKey={c.name}>
          <TableCell className="mono">{c.name}</TableCell>
          <TableCell className="muted">{c.dataType}</TableCell>
          <TableCell horizontalAlign="End">{formatNumber(c.nonNull)}</TableCell>
          <TableCell horizontalAlign="End">{formatNumber(c.distinct)}</TableCell>
          <TableCell horizontalAlign="End" className="mono">
            {"minHash" in c ? fingerprint(c.minHash) : "–"}
          </TableCell>
          <TableCell horizontalAlign="End" className="mono">
            {"maxHash" in c ? fingerprint(c.maxHash) : "–"}
          </TableCell>
          <TableCell horizontalAlign="End" className="mono">
            {c.sum ?? (c.sumHash ? fingerprint(c.sumHash) : "–")}
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}
