import { Button, Icon, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow } from "@ui5/webcomponents-react";
import { HEALTH_LABEL, HEALTH_STATES, type HealthState, type PipelineHealth } from "@ystara/shared";
import { useNavigate } from "react-router";
import { useCan, usePipelines, usePipelineSummaries, useScans, type PipelineDefinitionJson, type PipelineSummaryJson } from "../api";
import { monoColumnWidth } from "../columns";
import { EmptyState } from "../components/EmptyState";
import { ErrorStrip, HealthTag, Loading, When } from "../components/Feedback";
import { healthOf, NextStep } from "../components/Health";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { SpacesNote } from "../components/SpacesPicker";
import { formatNumber } from "../format";
import { useAddressTenant } from "../tenantScope";

interface Row {
  pipeline: PipelineDefinitionJson;
  summary: PipelineSummaryJson | undefined;
  health: PipelineHealth | undefined;
}

/**
 * Pipelines: the tenant's saved pipelines as a board, problems first. Each row
 * says in a word and a sentence what its latest results say (pipelineHealth),
 * with the step that follows; then its scenarios, latest snapshot, sign-off
 * and next scheduled snapshot. A row opens the pipeline; "New pipeline" opens
 * the latest scan to pick an output.
 */
export function PipelinesPage() {
  const { tenantId, tenant } = useAddressTenant();
  const navigate = useNavigate();
  const can = useCan();
  const pipelines = usePipelines(tenantId);
  const summaries = usePipelineSummaries(tenantId);
  const scans = useScans(tenantId);
  const scanned = scans.data?.find((s) => s.status === "succeeded");

  if (tenant.isPending) return <Loading />;
  if (!tenant.data) return <PageError error={tenant.error} what="tenant" />;

  const byId = new Map(summaries.data?.map((s) => [s.pipelineId, s]));
  const rows: Row[] = (pipelines.data ?? [])
    .map((pipeline) => {
      const summary = byId.get(pipeline.id);
      return { pipeline, summary, health: summary && healthOf(summary) };
    })
    .sort((a, b) => rank(a.health?.state) - rank(b.health?.state) || a.pipeline.name.localeCompare(b.pipeline.name));
  const counts = HEALTH_STATES.map((state) => [state, rows.filter((r) => r.health?.state === state).length] as const).filter(([, n]) => n > 0);
  // Two pipelines on one output are usually one saved twice (with other writers left out, or by two people).
  const onOutput = new Map<string, string[]>();
  for (const p of pipelines.data ?? []) {
    const key = `${p.output.space}.${p.output.technicalName}`;
    onOutput.set(key, [...(onOutput.get(key) ?? []), p.name]);
  }
  const sameOutputAs = (p: PipelineDefinitionJson) => (onOutput.get(`${p.output.space}.${p.output.technicalName}`) ?? []).filter((name) => name !== p.name);

  const newPipeline = can("pipelines.write") && (
    <Button
      design="Emphasized"
      icon="add"
      disabled={!scanned}
      tooltip={scanned ? "Pick the output of the new pipeline on the latest scan" : "Scan the tenant first, in Discovery"}
      onClick={() => scanned && navigate(`/scans/${scanned.id}`)}
    >
      New pipeline
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        title="Pipelines"
        subtitle={
          rows.length > 0 && summaries.data ? (
            <span className="facts">
              {counts.map(([state, n]) => (
                <span key={state}>
                  {n} {HEALTH_LABEL[state].toLowerCase()}
                </span>
              ))}
            </span>
          ) : (
            "Each saved pipeline with what its latest results say, problems first."
          )
        }
        actions={newPipeline}
      />
      <SpacesNote what="you see the pipelines whose output is in one of these spaces, with all their steps." />
      <ErrorStrip error={pipelines.error ?? summaries.error} />
      {pipelines.data?.length === 0 ? (
        <EmptyState
          icon="process"
          title="No saved pipelines yet"
          action={
            scanned && can("pipelines.write") ? (
              newPipeline
            ) : (
              <Button design="Emphasized" icon="search" onClick={() => navigate(`/tenants/${tenantId}/discovery`)}>
                Open Discovery
              </Button>
            )
          }
        >
          A pipeline is everything that feeds one output: the view or table people use. Pick that output on a scan and save its pipeline.
        </EmptyState>
      ) : (
        <Table
          loading={pipelines.isPending}
          overflowMode="Popin"
          className="board"
          onRowClick={(e) => navigate(`/pipelines/${e.detail.row.rowKey}`)}
          headerRow={
            <TableHeaderRow>
              {/* The sentence is what the board is for: the other columns keep a fixed width and leave it the room. */}
              <TableHeaderCell minWidth="18rem" importance={1}>
                Status
              </TableHeaderCell>
              {/* As wide as the longest output, so a technical name stays on one line where the table has room. */}
              <TableHeaderCell minWidth={monoColumnWidth(pipelines.data?.map((p) => `${p.output.space}.${p.output.technicalName}`) ?? [], 18)} importance={1}>
                Pipeline
              </TableHeaderCell>
              <TableHeaderCell width="8rem">Scenarios</TableHeaderCell>
              <TableHeaderCell width="9rem">Last snapshot</TableHeaderCell>
              <TableHeaderCell width="10rem">Sign-off</TableHeaderCell>
              <TableHeaderCell width="9rem">Next snapshot</TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {rows.map(({ pipeline: p, summary: s, health }) => (
            <TableRow key={p.id} rowKey={p.id} interactive>
              <TableCell>
                {health ? (
                  <div className="board-status">
                    <HealthTag state={health.state} />
                    <span>{health.sentence}</span>
                    <NextStep pipelineId={p.id} next={health.next} />
                  </div>
                ) : (
                  "…"
                )}
              </TableCell>
              <TableCell>
                <div className="board-name">
                  <span>
                    {p.name}
                    {s?.watching && (
                      <span title="You watch it: you get its alerts by email">
                        <Icon name="bell" className="board-watching" accessibleName="You watch it: you get its alerts by email" />
                      </span>
                    )}
                  </span>
                  <span className="mono muted wrap-anywhere">
                    {p.output.space}.{p.output.technicalName}
                  </span>
                  {sameOutputAs(p).length > 0 && <span className="text-attention">Same output as {sameOutputAs(p).join(", ")}</span>}
                </div>
              </TableCell>
              <TableCell>{s ? scenarios(s) : "–"}</TableCell>
              <TableCell>
                {s?.snapshot ? (
                  <div className="board-name">
                    <When iso={s.snapshot.finishedAt ?? s.snapshot.requestedAt} />
                    {s.snapshot.outputRows !== null && <span className="muted">{formatNumber(s.snapshot.outputRows)} rows out</span>}
                  </div>
                ) : (
                  <span className="muted">None yet</span>
                )}
              </TableCell>
              <TableCell>{signOff(s)}</TableCell>
              <TableCell>{s?.schedule ? <When iso={s.schedule.nextRunAt} /> : <span className="muted">Not scheduled</span>}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );
}

/** Problems first, then what hasn't been tested, then the rest; a pipeline whose summary is still loading last. */
const rank = (state: HealthState | undefined) => (state ? HEALTH_STATES.indexOf(state) : HEALTH_STATES.length);

/** "3 of 4 pass", from the latest run of all; or how many there are when they haven't run together. */
function scenarios(s: PipelineSummaryJson): string {
  if (s.scenarios === 0) return "None yet";
  const { suite } = s;
  if (suite?.total && (suite.status === "passed" || suite.status === "failed")) return `${suite.passed ?? 0} of ${suite.total} pass`;
  return `${s.scenarios}, not run together`;
}

function signOff(s: PipelineSummaryJson | undefined) {
  const o = s?.signOff;
  if (!o) return <span className="muted">Not signed off</span>;
  if (o.verdict === "approved" && o.outdated) {
    // Approved earlier, but not what the board shows now: say since what.
    return (
      <div className="board-name">
        <span className="text-attention">Approval outdated</span>
        <span className="muted">
          Approved <When iso={o.signedAt} />, before {o.outdatedBy === "result" ? "a later result" : "a scan that changed it"}
        </span>
      </div>
    );
  }
  return (
    <div className="board-name">
      <span className={o.verdict === "rejected" ? "text-attention" : undefined}>{o.verdict === "rejected" ? "Rejected" : "Approved"}</span>
      <When iso={o.signedAt} />
    </div>
  );
}
