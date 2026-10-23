import { Button, Icon, Link, MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Title } from "@ui5/webcomponents-react";
import { describeAlertReason, type ColumnMeasures, type Json, type SnapshotAlert, type SnapshotObject } from "@ystara/shared";
import { useNavigate, useParams } from "react-router";
import { emailDelivery, teamsDelivery } from "../alerts";
import { useSchedule, useSnapshot, useSnapshots, type SnapshotJson } from "../api";
import { monoColumnWidth } from "../columns";
import { ErrorStrip, Loading, ScanStatusTag, ShowOlder } from "../components/Feedback";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { counted, countedLatest, formatDateTime, formatDateTimesApart, formatExact, formatNumber, formatSeconds } from "../format";
import { notMeasurableLabel } from "../lineage/model";
import { typeLabel } from "../objectTypes";
import { useInTenant } from "../tenantScope";

/**
 * A saved pipeline's snapshots, newest first, the latest 50 and older ones on request; refreshed while one
 * is taken, and every minute while the pipeline has a schedule. `canTake`: a step is measurable.
 * Compare opens the latest two successful ones side by side; other pairs are picked there.
 */
export function SnapshotsSection({ pipelineId, canTake }: { pipelineId: string; canTake: boolean }) {
  const navigate = useNavigate();
  const snapshots = useSnapshots(pipelineId, !!useSchedule(pipelineId).data);
  const succeeded = (snapshots.data ?? []).filter((s) => s.status === "succeeded").length;
  const time = formatDateTimesApart((snapshots.data ?? []).map((s) => s.finishedAt ?? s.requestedAt));
  return (
    <section className="block">
      <div className="list-toolbar section-toolbar">
        <Title level="H2" size="H4">{snapshots.data ? countedLatest(snapshots.data.length, snapshots.hasNextPage, "snapshot") : "Snapshots"}</Title>
        <Button
          icon="compare"
          disabled={succeeded < 2}
          tooltip={succeeded < 2 ? "Two successful snapshots are needed to compare" : "See what changed between the latest two snapshots"}
          onClick={() => navigate(`/pipelines/${pipelineId}/compare`)}
        >
          Compare
        </Button>
      </div>
      <ErrorStrip error={snapshots.error} />
      <Table
        loading={snapshots.isPending}
        noDataText={canTake ? "No snapshots yet. Take one to measure the steps the database users can see." : "No snapshots yet."}
        overflowMode="Popin"
        onRowClick={(e) => navigate(`/snapshots/${e.detail.row.rowKey}`)}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="13rem" importance={1}>
              Taken
            </TableHeaderCell>
            <TableHeaderCell minWidth="8rem" importance={1}>
              Status
            </TableHeaderCell>
            <TableHeaderCell minWidth="7rem">How</TableHeaderCell>
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
            <TableCell>{time(s.finishedAt ?? s.requestedAt)}</TableCell>
            <TableCell>
              <ScanStatusTag status={s.status} />
            </TableCell>
            <TableCell>{s.scheduled ? (s.alert ? "Scheduled, alert" : "Scheduled") : "By hand"}</TableCell>
            <TableCell horizontalAlign="End" className="mono">{formatNumber(s.counts.measured)}</TableCell>
            <TableCell horizontalAlign="End" className="mono">{formatNumber(s.counts.notMeasurable)}</TableCell>
            <TableCell horizontalAlign="End" className="mono">{s.counts.failed ? formatNumber(s.counts.failed) : "–"}</TableCell>
          </TableRow>
        ))}
      </Table>
      <ShowOlder list={snapshots} what="snapshots" />
    </section>
  );
}

/**
 * One snapshot: the measures of each measured step, then every step of the
 * pipeline in order with what happened to it. Min and max (and a sum on a
 * small object) are shown as a lock, with the start of their hash in its
 * tooltip: Ystara never stores the value, and two snapshots are compared by these.
 */
export function SnapshotPage() {
  const { snapshotId = "" } = useParams();
  const snapshot = useSnapshot(snapshotId);
  useInTenant(snapshot.data?.tenantId);

  if (snapshot.isPending) return <Loading />;
  if (!snapshot.data) return <PageError error={snapshot.error} what="snapshot" />;
  const s = snapshot.data;
  const measured = s.objects.filter((o) => o.status === "measured");

  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { label: "Pipelines", to: `/tenants/${s.tenantId}/pipelines` },
          { label: s.pipelineName, to: `/pipelines/${s.pipelineId}/snapshots` },
        ]}
        title={`Snapshot of ${formatDateTime(s.finishedAt ?? s.requestedAt)}`}
        subtitle={
          <span className="facts">
            <ScanStatusTag status={s.status} />
            <Counts snapshot={s} />
            <span>{s.scheduled ? "Taken by the schedule" : "Taken by hand"}</span>
          </span>
        }
      />
      {s.error && (
        <MessageStrip design="Negative" hideCloseButton className="block">
          {s.error}
        </MessageStrip>
      )}
      {s.alert && <AlertStrip alert={s.alert} pipelineId={s.pipelineId} snapshotId={s.id} />}
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
          <Title level="H2" size="H4">
            <span className="mono wrap-anywhere">{o.technicalName}</span>
          </Title>
          <p className="muted">
            {typeLabel(o.type)}: {counted(o.rows ?? 0, "row")}, {counted(o.columns?.length ?? 0, "column")}
            {o.tookMs !== null && <>, measured in {formatSeconds(o.tookMs)}</>}
          </p>
          <ColumnsTable columns={o.columns ?? []} />
        </section>
      ))}
      <section className="block">
        <Title level="H2" size="H4">Every step</Title>
        <Table
          overflowMode="Popin"
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth={monoColumnWidth(s.objects.map((o) => o.technicalName))} importance={1}>
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

/** The alert this scheduled snapshot raised: why, and whether the watchers got it. */
function AlertStrip({ alert, pipelineId, snapshotId }: { alert: Json<SnapshotAlert>; pipelineId: string; snapshotId: string }) {
  const navigate = useNavigate();
  return (
    <MessageStrip design="Critical" hideCloseButton className="block wrap-anywhere">
      <strong>This scheduled snapshot raised an alert.</strong> {alert.reasons.map(describeAlertReason).join(" ")} {emailDelivery(alert)}{" "}
      {teamsDelivery(alert.teams)}{" "}
      {alert.comparedWith && (
        <Link onClick={() => navigate(`/pipelines/${pipelineId}/compare?from=${alert.comparedWith}&to=${snapshotId}`)}>Compare with the snapshot before</Link>
      )}
    </MessageStrip>
  );
}

function Counts({ snapshot: s }: { snapshot: SnapshotJson }) {
  const total = s.counts.measured + s.counts.notMeasurable + s.counts.failed;
  if (!total) return null;
  return (
    <span>
      {formatNumber(s.counts.measured)} of {counted(total, "step")} measured{s.counts.failed ? `, ${formatNumber(s.counts.failed)} failed` : ""}
    </span>
  );
}

/** Measured, why not (as on the pipeline page, where each step's details say more), or why it failed. */
function StepResult({ object: o }: { object: SnapshotObject }) {
  if (o.status === "measured") return <span>Measured: {counted(o.rows ?? 0, "row")}</span>;
  if (o.status === "failed") return <span className="text-negative">Failed: {o.reason}</span>;
  return <span className="muted">{notMeasurableLabel(o.reason as Parameters<typeof notMeasurableLabel>[0])}</span>;
}

/** A measure kept only as its hash: a lock, with the hash's start (enough to tell two apart) in its tooltip. */
function Fingerprint({ hash, what }: { hash: string | null | undefined; what: string }) {
  if (!hash) return <>–</>;
  return <Icon name="locked" className="fingerprint" showTooltip accessibleName={`${what}: kept only as the fingerprint ${hash.slice(0, 8)}…, never as the value`} />;
}

/** On a narrow screen the type goes under the column name first, then the measures from the right. The name and the sum keep their width. */
function ColumnsTable({ columns }: { columns: ColumnMeasures[] }) {
  return (
    <Table
      overflowMode="Popin"
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell minWidth={monoColumnWidth(columns.map((c) => c.name))} importance={2}>
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
          <TableHeaderCell minWidth={monoColumnWidth(columns.map((c) => c.sum && formatExact(c.sum)))} horizontalAlign="End">
            Sum
          </TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {columns.map((c) => (
        <TableRow key={c.name} rowKey={c.name}>
          <TableCell className="mono">{c.name}</TableCell>
          <TableCell className="muted">{c.dataType}</TableCell>
          <TableCell horizontalAlign="End" className="mono">{formatNumber(c.nonNull)}</TableCell>
          <TableCell horizontalAlign="End" className="mono">{formatNumber(c.distinct)}</TableCell>
          <TableCell horizontalAlign="End" className="mono">
            {"minHash" in c ? <Fingerprint hash={c.minHash} what="Min" /> : "–"}
          </TableCell>
          <TableCell horizontalAlign="End" className="mono">
            {"maxHash" in c ? <Fingerprint hash={c.maxHash} what="Max" /> : "–"}
          </TableCell>
          <TableCell horizontalAlign="End" className="mono">
            {typeof c.sum === "string" ? formatExact(c.sum) : <Fingerprint hash={c.sumHash} what="Sum" />}
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}
