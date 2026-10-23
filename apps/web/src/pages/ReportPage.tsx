import { Button } from "@ui5/webcomponents-react";
import type { ObjectType, Verdict } from "@ystara/shared";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { isUnauthorized, useMe, usePipelineReport, type PipelineReportJson } from "../api";
import { Loading } from "../components/Feedback";
import { Mark } from "../components/Logo";
import { PageError, StartError } from "../components/PageError";
import { useDocumentTitle } from "../components/PageHeader";
import { counted, formatDateTime, formatNumber } from "../format";
import { typeLabel } from "../objectTypes";
import { coverage, detailOf, whatOf } from "./History";

/**
 * A pipeline's report (/pipelines/:id/report), for whoever answers for its
 * results: its sign-off and what it covered, the latest suite with every
 * check, the latest two snapshots compared, its steps, and its recent
 * history. A page of its own, without the app's menu, so that printing it
 * (or saving it as PDF from the print dialog) gives just the report.
 */
export function ReportPage() {
  const { pipelineId = "" } = useParams();
  const me = useMe();
  const location = useLocation();
  const report = usePipelineReport(pipelineId);
  useDocumentTitle(report.data ? `${report.data.pipeline.name} · Ystara report` : "Ystara report");

  if (me.isPending) return <Loading />;
  // As Layout: the sign-in page only on arriving without one; a sign-in that ends later keeps the report ("Your sign-in ended").
  if (!me.data) {
    if (isUnauthorized(me.error)) return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname)}`} replace />;
    return <StartError error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />;
  }

  return (
    <div className="report">
      <div className="report-actions">
        <Link to={`/pipelines/${pipelineId}/history`}>Back to the pipeline</Link>
        <Button design="Emphasized" icon="print" disabled={!report.data} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      {report.isPending ? <Loading /> : report.data ? <Report report={report.data} /> : <PageError error={report.error} what="pipeline" />}
    </div>
  );
}

/** "succeeded" as "Succeeded". */
const sentence = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const VERDICT: Record<Verdict | "added" | "removed", string> = {
  unchanged: "Unchanged",
  data_changed: "Data changed",
  definition_changed: "Definition changed",
  // As the Compare page says it.
  both: "Data and definition changed",
  added: "Added",
  removed: "Removed",
};

function Report({ report }: { report: PipelineReportJson }) {
  const { pipeline, signOff, suite, comparison, steps } = report;
  const latest = signOff.latest;
  return (
    <article className="report-sheet">
      <header className="report-header">
        <div className="report-brand">
          <Mark size={28} />
          <span>Ystara · pipeline report</span>
        </div>
        <h1>{pipeline.name}</h1>
        <dl className="report-facts">
          <div>
            <dt>Output</dt>
            <dd className="mono">
              {pipeline.output.space}.{pipeline.output.technicalName}
            </dd>
          </div>
          <div>
            <dt>Tenant</dt>
            <dd>
              {report.tenant.name}
              {report.tenant.host && <span className="muted"> · {new URL(report.tenant.host).host}</span>}
            </dd>
          </div>
          <div>
            <dt>Made</dt>
            <dd>
              {formatDateTime(report.generatedAt)} by {report.generatedBy}
            </dd>
          </div>
        </dl>
      </header>

      <section>
        <h2>Sign-off</h2>
        {latest ? (
          <>
            <p>
              <span className={`report-badge is-${latest.verdict}`}>{latest.verdict === "approved" ? "Approved" : "Rejected"}</span> by {latest.signedBy} on{" "}
              {formatDateTime(latest.signedAt)}.
            </p>
            {latest.comment && <blockquote className="signoff-comment">{latest.comment}</blockquote>}
            <p>It covers {coverage(latest)}.</p>
            {signOff.changedSince && signOff.changedSince.length > 0 && (
              <p className="report-warning">
                Since then, a later scan changed {counted(signOff.changedSince.length, "step")}:{" "}
                <span className="mono">{signOff.changedSince.map((c) => `${c.technicalName} (${c.change})`).join(", ")}</span>. This sign-off no longer covers the
                pipeline as it is.
              </p>
            )}
            {signOff.outdatedBy === "result" && (
              <p className="report-warning">Since then, a later result fails, changed or found no rows in the output. This sign-off no longer covers the pipeline as it is.</p>
            )}
          </>
        ) : (
          <p>Not signed off yet.</p>
        )}
      </section>

      <section>
        <h2>Scenarios</h2>
        {suite ? (
          <>
            <p>
              The latest run of all scenarios, {suite.cause === "scan" ? "after a scan, " : ""}on {formatDateTime(suite.finishedAt)}:{" "}
              <strong>
                {suite.passed ?? 0} of {counted(suite.total ?? 0, "scenario")} passed
              </strong>
              .
            </p>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th className="report-result">Result</th>
                  <th>Found</th>
                </tr>
              </thead>
              {suite.runs.map((r) => (
                <tbody key={r.id}>
                  <tr className="report-group">
                    <th colSpan={3} scope="rowgroup">
                      {r.scenarioName}
                      {!r.checks?.length && <span className="muted"> · {r.error ?? sentence(r.status)}</span>}
                    </th>
                  </tr>
                  {r.checks?.map((c, i) => (
                    <tr key={i}>
                      <td data-label="Check" className="mono">
                        {c.checkpoint}: {c.label}
                      </td>
                      <td data-label="Result" className="report-result">
                        {c.status === "pass" ? "Pass" : c.status === "fail" ? "Fail" : c.status === "error" ? "Error" : "Not run"}
                      </td>
                      <td data-label="Found">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </>
        ) : (
          <p>No run of all scenarios has finished yet.</p>
        )}
      </section>

      <section>
        <h2>Snapshots</h2>
        {comparison ? (
          <>
            <p>
              The latest two, of {formatDateTime(comparison.before.finishedAt)} and {formatDateTime(comparison.after.finishedAt)}: <strong>{VERDICT[comparison.verdict].toLowerCase()}</strong>
              .
            </p>
            {comparison.changed.length > 0 && (
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th className="report-result">Type</th>
                    <th className="report-result">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.changed.map((c) => (
                    <tr key={`${c.space}.${c.technicalName}`}>
                      <td data-label="Step" className="mono">
                        {c.space}.{c.technicalName}
                      </td>
                      <td data-label="Type" className="report-result">
                        {typeLabel(c.type as ObjectType)}
                      </td>
                      <td data-label="Change" className="report-result">
                        {VERDICT[c.verdict]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p>Fewer than two successful snapshots, so there is nothing to compare.</p>
        )}
      </section>

      <section>
        <h2>Steps</h2>
        {steps ? (
          <>
            <p>Upstream first, from the scan of {formatDateTime(steps.finishedAt)}.</p>
            <ol className="report-steps">
              {steps.steps.map((s) => (
                <li key={`${s.space}.${s.technicalName}`}>
                  <span className="mono">
                    {s.space}.{s.technicalName}
                  </span>{" "}
                  <span className="muted">{typeLabel(s.type)}</span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p>The latest scan doesn't have the pipeline's output.</p>
        )}
      </section>

      <section>
        <h2>History</h2>
        {report.history.length ? (
          <table className="report-table">
            <thead>
              <tr>
                <th className="report-result">When</th>
                <th>What</th>
                <th className="report-result">Result</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {report.history.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td data-label="When" className="report-result">
                    {formatDateTime(e.at)}
                  </td>
                  <td data-label="What">{whatOf(e)}</td>
                  <td data-label="Result" className="report-result">
                    {sentence(e.kind === "signoff" ? e.verdict : e.status)}
                  </td>
                  <td data-label="Details">{detailOf(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>Nothing yet.</p>
        )}
        <p className="muted">The last {formatNumber(report.history.length)} events. The pipeline's History tab downloads all of them as CSV.</p>
      </section>

      <footer className="report-footer muted">
        Ystara reads Datasphere only, and keeps metadata and results: no row of the tenant's data is in this report.
      </footer>
    </article>
  );
}
