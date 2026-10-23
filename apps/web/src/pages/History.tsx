import { useState } from "react";
import {
  Button,
  Label,
  MessageStrip,
  RadioButton,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Tag,
  TextArea,
  Title,
} from "@ui5/webcomponents-react";
import type { SignOffVerdict } from "@ystara/shared";
import { useNavigate } from "react-router";
import { HISTORY_EVENTS, useCan, useDownload, usePipelineHistory, useSignOff, useSignOffs, type HistoryEventJson, type SignOffJson, type SignOffStateJson } from "../api";
import { ColumnChart, formatCompact, LineChart, type ChartPoint } from "../components/Charts";
import { Dialog } from "../components/Dialog";
import { ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { InfoButton, QuietNote } from "../components/Info";
import { counted, countedLatest, formatDateTime, formatNumber } from "../format";
import { RunStatusTag } from "./Scenarios";

/**
 * The History tab of a saved pipeline: its sign-off (who approved or rejected
 * its results, when, on what, and whether a later scan changed it since), two
 * trends (scenarios passing per suite, output rows per snapshot), and every
 * suite, scenario run, snapshot and sign-off on one timeline, which the
 * report and the CSV export carry too.
 */
export function HistorySection({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const history = usePipelineHistory(pipelineId);
  const signOffs = useSignOffs(pipelineId);
  const download = useDownload();
  const events = history.data ?? [];
  // The API sends the latest HISTORY_EVENTS; the CSV has them all.
  const more = events.length >= HISTORY_EVENTS;

  // Oldest first, as the charts read left to right; the last 30 of each.
  const suites = events.filter((e) => e.kind === "suite" && e.total !== null && e.passed !== null).reverse().slice(-30);
  const snapshots = events.filter((e) => e.kind === "snapshot" && e.outputRows !== null).reverse().slice(-30);
  const suitePoints: ChartPoint[] = suites.flatMap((e) =>
    e.kind === "suite" && e.total ? [{ key: e.id, value: (100 * e.passed!) / e.total, tooltip: [`${e.passed} of ${counted(e.total, "scenario")} passed`, formatDateTime(e.at)] }] : [],
  );
  const rowPoints: ChartPoint[] = snapshots.flatMap((e) =>
    e.kind === "snapshot" && e.outputRows !== null ? [{ key: e.id, value: e.outputRows, tooltip: [`${formatNumber(e.outputRows)} rows`, formatDateTime(e.at)] }] : [],
  );
  const lastSuite = suites.at(-1);
  const lastRows = rowPoints.at(-1);

  return (
    <>
      <SignOffSection pipelineId={pipelineId} state={signOffs.data} error={signOffs.error} />
      <div className="chart-row" role="group" aria-label="Trends">
        <section className="block chart-card">
          <span className="title-with-info">
            <Title level="H2" size="H5">
              Scenarios passing
            </Title>
            <InfoButton label="About scenarios passing">The share of the pipeline&apos;s scenarios that passed, each time all of them ran.</InfoButton>
          </span>
          {suitePoints.length ? (
            <ColumnChart
              label="Scenarios passing, per suite, in percent"
              points={suitePoints}
              max={100}
              tickText={(n) => `${n} %`}
              endLabel={lastSuite?.kind === "suite" ? `${lastSuite.passed}/${lastSuite.total}` : ""}
            />
          ) : (
            <p className="chart-empty muted">No run of all scenarios yet.</p>
          )}
        </section>
        <section className="block chart-card">
          <span className="title-with-info">
            <Title level="H2" size="H5">
              Output rows
            </Title>
            <InfoButton label="About output rows">The rows of the pipeline&apos;s output, each time a snapshot measured it.</InfoButton>
          </span>
          {rowPoints.length ? (
            <LineChart label="Output rows, per snapshot" points={rowPoints} endLabel={lastRows ? formatCompact(lastRows.value) : ""} />
          ) : (
            <p className="chart-empty muted">No snapshot has measured the output yet.</p>
          )}
        </section>
      </div>

      <section className="block">
        <div className="list-toolbar section-toolbar">
          <Title level="H2" size="H4">{history.data ? countedLatest(events.length, more, "event") : "Timeline"}</Title>
          <Button
            icon="download"
            onClick={() => download.mutate({ path: `/pipelines/${pipelineId}/history.csv`, name: "ystara-history.csv" })}
            disabled={!events.length || download.isPending}
          >
            Download CSV
          </Button>
          <Button icon="print" onClick={() => navigate(`/pipelines/${pipelineId}/report`)}>
            Report
          </Button>
        </div>
        {more && <p className="muted">The timeline shows the latest {formatNumber(HISTORY_EVENTS)} events. Download CSV has every one of them.</p>}
        <ErrorStrip error={history.error ?? download.error} />
        {history.isPending ? (
          <Loading />
        ) : (
          <Table
            noDataText="Nothing has happened to this pipeline yet: no suite, scenario run, snapshot or sign-off."
            overflowMode="Popin"
            onRowClick={(e) => {
              const to = e.detail.row.dataset.to;
              if (to) navigate(to);
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell minWidth="12rem" importance={1}>
                  When
                </TableHeaderCell>
                <TableHeaderCell minWidth="12rem" importance={1}>
                  What
                </TableHeaderCell>
                <TableHeaderCell minWidth="8rem">Result</TableHeaderCell>
                <TableHeaderCell minWidth="14rem">Details</TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {events.map((e) => (
              <TableRow key={`${e.kind}-${e.id}`} rowKey={`${e.kind}-${e.id}`} data-to={linkOf(e, pipelineId)} interactive={e.kind !== "signoff"}>
                <TableCell>{formatDateTime(e.at)}</TableCell>
                <TableCell>{whatOf(e)}</TableCell>
                <TableCell>
                  <ResultTag event={e} />
                </TableCell>
                <TableCell className="wrap-anywhere">{detailOf(e)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}

const linkOf = (e: HistoryEventJson, pipelineId: string) =>
  e.kind === "suite" ? `/scenario-suites/${e.id}` : e.kind === "run" ? `/scenario-runs/${e.id}` : e.kind === "snapshot" ? `/snapshots/${e.id}` : `/pipelines/${pipelineId}/history`;

export function whatOf(e: HistoryEventJson): string {
  switch (e.kind) {
    case "suite":
      return e.cause === "scan" ? "All scenarios, after a scan" : "All scenarios";
    case "run":
      return `Scenario: ${e.scenarioName}`;
    case "snapshot":
      return e.scheduled ? "Scheduled snapshot" : "Snapshot";
    case "signoff":
      return "Sign-off";
  }
}

export function detailOf(e: HistoryEventJson): string {
  switch (e.kind) {
    case "suite":
      return [e.total !== null && `${e.passed ?? 0} of ${counted(e.total, "scenario")} passed`, e.cause === "scan" && e.changed > 0 && `the scan changed ${counted(e.changed, "step")}`]
        .filter(Boolean)
        .join("; ");
    case "run":
      return e.total !== null ? `${e.passed ?? 0} of ${counted(e.total, "check")} passed` : "";
    case "snapshot":
      return [e.outputRows !== null && `${formatNumber(e.outputRows)} output rows`, e.alert && "raised an alert"].filter(Boolean).join("; ");
    case "signoff":
      return e.comment ? `${e.by}: “${e.comment}”` : e.by;
  }
}

export function ResultTag({ event: e }: { event: HistoryEventJson }) {
  if (e.kind === "snapshot") return <ScanStatusTag status={e.status} />;
  if (e.kind === "signoff") return <VerdictTag verdict={e.verdict} />;
  return <RunStatusTag status={e.status} />;
}

export const VerdictTag = ({ verdict }: { verdict: SignOffVerdict }) =>
  verdict === "approved" ? <Tag design="Positive">Approved</Tag> : <Tag design="Negative">Rejected</Tag>;

/** The pipeline's sign-off in a word, for its header: approved, rejected, or approved but changed since. Nothing before the first one. */
export function SignOffTag({ pipelineId }: { pipelineId: string }) {
  const state = useSignOffs(pipelineId).data;
  const latest = state?.latest;
  if (!latest) return null;
  if (latest.verdict === "approved" && state.outdatedBy) {
    const since =
      state.outdatedBy === "scan" && state.changedSince?.length
        ? `a later scan changed ${counted(state.changedSince.length, "step")} since`
        : "a result that came in since fails, changed or found no rows";
    return (
      <Tag design="Critical" title={`Approved on ${formatDateTime(latest.signedAt)}; ${since}`}>
        Approval outdated
      </Tag>
    );
  }
  return (
    <span title={`${latest.verdict === "approved" ? "Approved" : "Rejected"} by ${latest.signedBy} on ${formatDateTime(latest.signedAt)}`}>
      <VerdictTag verdict={latest.verdict} />
    </span>
  );
}

/** What a sign-off covers, in a sentence: "the scan of …, all scenarios (5 of 6 passed) of … and the snapshot of …". */
export function coverage(s: Pick<SignOffJson, "scan" | "suite" | "snapshot">): string {
  const parts = [
    s.scan && `the scan of ${formatDateTime(s.scan.finishedAt)}`,
    s.suite && `all scenarios run on ${formatDateTime(s.suite.finishedAt)} (${s.suite.total === null ? "not run" : `${s.suite.passed ?? 0} of ${s.suite.total} passed`})`,
    s.snapshot && `the snapshot of ${formatDateTime(s.snapshot.finishedAt)}`,
  ].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "nothing that is still kept");
}

function SignOffSection({ pipelineId, state, error }: { pipelineId: string; state: SignOffStateJson | undefined; error: Error | null }) {
  const can = useCan();
  const [signing, setSigning] = useState(false);
  const latest = state?.latest;
  const ready = !!state?.basis.scan && !!(state.basis.suite || state.basis.snapshot);

  return (
    <section className="block signoff">
      <div className="signoff-head">
        <div>
          <Title level="H2" size="H4">Sign-off</Title>
          {!state ? null : latest ? (
            <p className="signoff-line">
              <VerdictTag verdict={latest.verdict} /> by {latest.signedBy} on {formatDateTime(latest.signedAt)}
              <InfoButton label="What this sign-off covers">It covers {coverage(latest)}.</InfoButton>
            </p>
          ) : (
            <p className="muted">Not signed off yet. A test coordinator or an admin approves or rejects the pipeline's results here.</p>
          )}
        </div>
        {can("results.sign_off") && (
          <Button
            design="Emphasized"
            icon="signature"
            disabled={!ready}
            tooltip={ready ? "Approve or reject the pipeline's results as they are now" : "Run the scenarios or take a snapshot first: a sign-off covers their results"}
            onClick={() => setSigning(true)}
          >
            Sign off
          </Button>
        )}
      </div>
      <ErrorStrip error={error} />
      {latest && (
        <>
          {latest.comment && <blockquote className="signoff-comment">{latest.comment}</blockquote>}
        </>
      )}
      {latest && state.changedSince && state.changedSince.length > 0 && (
        <QuietNote
          tone="warn"
          moreLabel="Which steps changed"
          more={
            <ul className="info-list">
              {state.changedSince.map((c) => (
                <li key={c.technicalName}>
                  <span className="mono wrap-anywhere">{c.technicalName}</span> <span className="muted">{c.change}</span>
                </li>
              ))}
            </ul>
          }
        >
          Outdated: a later scan changed {counted(state.changedSince.length, "step")} of the pipeline. Check the results again and sign off anew.
        </QuietNote>
      )}
      {latest && state.outdatedBy === "result" && (
        <QuietNote tone="warn">Outdated: a later result fails, changed or found no rows in the output. Check the latest results and sign off anew.</QuietNote>
      )}
      {signing && state && <SignOffDialog pipelineId={pipelineId} state={state} onClose={() => setSigning(false)} />}
    </section>
  );
}

function SignOffDialog({ pipelineId, state, onClose }: { pipelineId: string; state: SignOffStateJson; onClose: () => void }) {
  const signOff = useSignOff(pipelineId);
  const [verdict, setVerdict] = useState<SignOffVerdict>("approved");
  const [comment, setComment] = useState("");
  const needsComment = verdict === "rejected" && !comment.trim();

  return (
    <Dialog
      headerText="Sign off the pipeline"
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button
            design="Emphasized"
            disabled={needsComment || signOff.isPending}
            onClick={() => signOff.mutate({ verdict, comment: comment.trim() }, { onSuccess: onClose })}
          >
            {verdict === "approved" ? "Approve" : "Reject"}
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>This sign-off covers {coverage(state.basis)}. It is kept with your name and the time, and can't be changed afterwards; a later one takes its place.</p>
        {state.basis.suite && state.basis.suite.status !== "passed" && (
          <MessageStrip design="Critical" hideCloseButton>
            Not every scenario passed in the latest suite.
          </MessageStrip>
        )}
        <div role="radiogroup" aria-label="Verdict" className="signoff-verdict">
          <RadioButton name="verdict" text="Approve: the results are as expected" checked={verdict === "approved"} onChange={() => setVerdict("approved")} />
          <RadioButton name="verdict" text="Reject: something needs fixing" checked={verdict === "rejected"} onChange={() => setVerdict("rejected")} />
        </div>
        <Label for="signoff-comment" required={verdict === "rejected"}>
          Comment
        </Label>
        <TextArea
          id="signoff-comment"
          value={comment}
          rows={3}
          maxlength={2000}
          placeholder={verdict === "rejected" ? "What needs fixing" : "Optional: what you checked"}
          onInput={(e) => setComment(e.target.value)}
        />
        <ErrorStrip error={signOff.error} />
      </div>
    </Dialog>
  );
}
