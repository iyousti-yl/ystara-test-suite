import { useState } from "react";
import { Button, Input, Label, Link, MessageStrip, Tab, TabContainer, ToggleButton, Token, Tokenizer } from "@ui5/webcomponents-react";
import { refKey, whyNothingMeasurable, type PipelineResult } from "@ystara/shared";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  pipelineQuery,
  useCan,
  useDeletePipeline,
  usePipelineOnScan,
  usePipelines,
  usePipelineSummaries,
  useSavedPipeline,
  useSavePipeline,
  useScan,
  useSetWatching,
  useTakeSnapshot,
  useTenant,
  useWatch,
  type PipelineDefinitionJson,
  type PipelineSummaryJson,
} from "../api";
import { Dialog } from "../components/Dialog";
import { ErrorStrip, HealthTag, Loading, When } from "../components/Feedback";
import { healthOf, NextStep } from "../components/Health";
import { MoreActions } from "../components/MoreActions";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { NAME_MAX } from "../fields";
import { counted, formatDateTime } from "../format";
import { PipelineView } from "../lineage/PipelineView";
import { useInTenant } from "../tenantScope";
import { HistorySection, SignOffTag } from "./History";
import { ScenariosSection } from "./Scenarios";
import { ScheduleSection } from "./Schedule";
import { SnapshotsSection } from "./Snapshots";

/**
 * Trying a pipeline on one scan: /scans/:scanId/pipeline?output=SPACE.NAME&excludeWriter=PATTERN...
 * The output and exclusions live in the URL, so a link shows exactly this picture.
 */
export function PipelineOnScanPage() {
  const { scanId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const can = useCan();
  const output = params.get("output") ?? "";
  const excludeWriters = params.getAll("excludeWriter");
  const scan = useScan(scanId);
  useInTenant(scan.data?.tenantId);
  const result = usePipelineOnScan(scanId, output, excludeWriters);
  const [saving, setSaving] = useState(false);

  const setExclusions = (patterns: string[]) => setParams(pipelineQuery(output, [...new Set(patterns)]), { replace: true });
  const outputName = output.split(".").pop() ?? output;
  if (!scan.data && scan.error) return <PageError error={scan.error} what="scan" />;

  return (
    <div className="page page-wide page-fill">
      <PageHeader
        crumbs={[
          { label: "Discovery", to: `/tenants/${scan.data?.tenantId ?? ""}/discovery` },
          { label: `Scan of ${scan.data?.spaces.join(", ") ?? "…"}`, to: `/scans/${scanId}` },
        ]}
        title={outputName}
        subtitle={
          <span className="facts">
            <span>Pipeline on the scan of {formatDateTime(scan.data?.finishedAt)}</span>
            <Summary result={result.data} />
          </span>
        }
        actions={
          can("pipelines.write") && (
            <Button design="Emphasized" icon="save" disabled={!result.data || !scan.data} onClick={() => setSaving(true)}>
              Save pipeline
            </Button>
          )
        }
      />
      <Exclusions patterns={excludeWriters} onRemove={(p) => setExclusions(excludeWriters.filter((x) => x !== p))} />
      <ErrorStrip error={result.error} />
      {result.isPending && <Loading text="Tracing the pipeline…" />}
      {result.data && (
        <PipelineView
          result={result.data}
          onExclusionsChange={setExclusions}
          onShowPipeline={(key) => navigate(`/scans/${scanId}/pipeline?${pipelineQuery(key, [])}`)}
        />
      )}
      {saving && result.data && scan.data && (
        <SaveDialog
          tenantId={scan.data.tenantId}
          output={`${result.data.pipeline.output.space}.${result.data.pipeline.output.technicalName}`}
          excludeWriters={excludeWriters}
          // The output's business name, when the tenant gives one; otherwise the person names it.
          suggestedName={result.data.graph.nodes.find((n) => refKey(n) === refKey(result.data.pipeline.output))?.businessName ?? ""}
          onClose={() => setSaving(false)}
          onSaved={(id) => navigate(`/pipelines/${id}`)}
        />
      )}
    </div>
  );
}

type PipelineTab = "lineage" | "snapshots" | "scenarios" | "history";

/**
 * A saved pipeline, computed on the tenant's latest successful scan, in four
 * tabs with their own addresses: its lineage (/pipelines/:id), its snapshots
 * (/pipelines/:id/snapshots), its scenarios (/pipelines/:id/scenarios) and
 * its history with its sign-off (/pipelines/:id/history).
 * Taking a snapshot opens the second.
 */
export function SavedPipelinePage({ tab }: { tab: PipelineTab }) {
  const { pipelineId = "" } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const result = useSavedPipeline(pipelineId);
  const takeSnapshot = useTakeSnapshot(pipelineId);
  const [deleting, setDeleting] = useState(false);
  const definition = result.data?.definition;
  const tenant = useTenant(definition?.tenantId ?? "");
  const summary = usePipelineSummaries(definition?.tenantId ?? "").data?.find((s) => s.pipelineId === pipelineId);
  useInTenant(definition?.tenantId);
  const tabPath = (t: PipelineTab) => (t === "lineage" ? `/pipelines/${pipelineId}` : `/pipelines/${pipelineId}/${t}`);

  if (result.isPending) return <Loading />;
  if (!result.data || !definition) return <PageError error={result.error} what="pipeline" />;
  const output = `${definition.output.space}.${definition.output.technicalName}`;
  const measurable = Object.values(result.data.measurement).some((m) => m.measurable);
  // Shown to those who could take a snapshot, once the tenant is known (an imported-only tenant has another reason).
  const whyNot = !measurable && tenant.data ? whyNothingMeasurable(result.data.pipeline.steps, result.data.measurement, tenant.data.host !== null) : undefined;

  return (
    <div className={tab === "lineage" ? "page page-wide page-fill" : "page page-wide"}>
      <PageHeader
        crumbs={[{ label: "Pipelines", to: `/tenants/${definition.tenantId}/pipelines` }]}
        title={definition.name}
        subtitle={
          <span className="facts">
            <span className="mono wrap-anywhere">{output}</span>
            <Summary result={result.data} saved />
            <SignOffTag pipelineId={definition.id} />
          </span>
        }
        actions={
          <>
            {can("runs.execute") && (
              <Button
                // The page's one primary action, except on Scenarios (New scenario) and History (Sign off). Disabled, it looks the same on every tab.
                design={tab === "scenarios" || tab === "history" || !measurable ? "Default" : "Emphasized"}
                icon="camera"
                disabled={!measurable || takeSnapshot.isPending}
                tooltip={measurable ? "Measure the steps the database users can see" : (whyNot ?? "No step can be measured with SQL yet")}
                onClick={() => takeSnapshot.mutate(undefined, { onSuccess: () => navigate(tabPath("snapshots")) })}
              >
                Take snapshot
              </Button>
            )}
            <WatchButton pipelineId={definition.id} />
            <MoreActions
              actions={[
                {
                  text: "Change ignored loaders",
                  icon: "chain-link",
                  onClick: () => navigate(`/scans/${result.data.scanId}/pipeline?${pipelineQuery(output, definition.excludeWriters)}`),
                },
                can("pipelines.write") && { text: "Delete pipeline", icon: "delete", onClick: () => setDeleting(true) },
              ]}
            />
          </>
        }
      />
      {summary && <StatusLine pipelineId={definition.id} summary={summary} />}
      <TabContainer
        collapsed
        className="page-tabs"
        onTabSelect={(e) => {
          const to = e.detail.tab.dataset.tab as PipelineTab | undefined;
          if (to && to !== tab) navigate(tabPath(to));
        }}
      >
        <Tab text="Lineage" data-tab="lineage" selected={tab === "lineage"} />
        <Tab text="Snapshots" data-tab="snapshots" selected={tab === "snapshots"} />
        <Tab text="Scenarios" data-tab="scenarios" selected={tab === "scenarios"} />
        <Tab text="History" data-tab="history" selected={tab === "history"} />
      </TabContainer>
      <ErrorStrip error={takeSnapshot.error} />
      {tab === "lineage" ? (
        <>
          <Exclusions patterns={definition.excludeWriters} />
          <PipelineView result={result.data} />
        </>
      ) : tab === "scenarios" ? (
        <ScenariosSection pipelineId={definition.id} tenantId={definition.tenantId} />
      ) : tab === "history" ? (
        <HistorySection pipelineId={definition.id} />
      ) : (
        <>
          {whyNot && can("runs.execute") && (
            <MessageStrip design="Information" hideCloseButton>
              No snapshot can be taken yet. {whyNot}
            </MessageStrip>
          )}
          <ScheduleSection pipelineId={definition.id} whyNot={measurable ? undefined : (whyNot ?? "No step can be measured with SQL yet")} />
          <SnapshotsSection pipelineId={definition.id} canTake={measurable} />
        </>
      )}
      {deleting && <DeletePipelineDialog definition={definition} summary={summary} onClose={() => setDeleting(false)} />}
    </div>
  );
}

/**
 * Says what goes with a saved pipeline before it is deleted: everything Ystara keeps for it, its sign-offs
 * among it, which are the record of who approved it. The audit log keeps its entries. Nothing in Datasphere.
 */
function DeletePipelineDialog({ definition, summary, onClose }: { definition: PipelineDefinitionJson; summary?: PipelineSummaryJson; onClose: () => void }) {
  const navigate = useNavigate();
  const remove = useDeletePipeline();
  const scenarios = summary?.scenarios;
  const goes = [
    scenarios === undefined
      ? "its scenarios, with their test rows, checks and runs"
      : scenarios > 0 && `${counted(scenarios, "scenario")}, with ${scenarios === 1 ? "its" : "their"} test rows, checks and runs`,
    "its runs of all scenarios, and the alerts they raised",
    "its snapshots, and the alerts they raised",
    summary?.schedule !== null && "its snapshot schedule",
    "who watches it: they get no more alerts for it",
    "its sign-offs: who approved or rejected it, and when",
  ].filter((line): line is string => typeof line === "string");

  return (
    <Dialog
      state="Negative"
      headerText={`Delete ${definition.name}?`}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button
            design="Negative"
            disabled={remove.isPending}
            onClick={() => remove.mutate(definition, { onSuccess: () => navigate(`/tenants/${definition.tenantId}/pipelines`, { replace: true }) })}
          >
            Delete pipeline
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>This removes the saved pipeline from Ystara, with everything stored for it:</p>
        <ul className="deleted-with">
          {goes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <MessageStrip design="Critical" hideCloseButton>
          Sign-offs are evidence for an audit. To keep them, download the pipeline&apos;s history first (History, Download CSV). The account&apos;s audit log
          keeps its entries.
        </MessageStrip>
        <MessageStrip design="Information" hideCloseButton>
          Nothing is deleted or changed in Datasphere.
        </MessageStrip>
        <p className="muted">This can&apos;t be undone. To test this output again, save its pipeline again from a scan.</p>
        <ErrorStrip error={remove.error} />
      </div>
    </Dialog>
  );
}

/** Watchers get an email when a scheduled snapshot of the pipeline, or a rerun of its scenarios after a scan, calls for an alert. Anyone in the account can watch. */
function WatchButton({ pipelineId }: { pipelineId: string }) {
  const watch = useWatch(pipelineId);
  const setWatching = useSetWatching(pipelineId);
  const state = watch.data;
  const others = state ? state.watchers - (state.watching ? 1 : 0) : 0;
  const tooltip = `${state?.watching ? "You get" : "Get"} an email when a scheduled snapshot fails or its output or definitions change, and when a scenario breaks after a scan.${
    others ? ` ${others === 1 ? "1 other person watches" : `${others} other people watch`} this pipeline.` : ""
  }`;
  return (
    <ToggleButton
      icon="bell"
      pressed={!!state?.watching}
      disabled={!state || setWatching.isPending}
      tooltip={tooltip}
      onClick={() => state && setWatching.mutate(!state.watching)}
    >
      {state?.watching ? "Watching" : "Watch"}
    </ToggleButton>
  );
}

/** "4 steps, 1 input table, 2 measurable": a saved pipeline's steps are worked out again from the latest scan. */
function Summary({ result, saved }: { result: PipelineResult | undefined; saved?: boolean }) {
  if (!result) return null;
  const { pipeline } = result;
  const measurable = Object.values(result.measurement).filter((m) => m.measurable).length;
  return (
    <span title={saved ? "Worked out again from the tenant's latest successful scan" : undefined}>
      {counted(pipeline.steps.length, "step")}
      {saved && " from the latest scan"}, {counted(pipeline.entryPoints.length, "input table")}, {measurable} measurable by snapshots
    </span>
  );
}

/** What the pipeline's latest results say, in a word and a sentence, with the next step and when its snapshots ran and will run. */
function StatusLine({ pipelineId, summary }: { pipelineId: string; summary: PipelineSummaryJson }) {
  const health = healthOf(summary);
  return (
    <div className="status-line" role="status">
      <HealthTag state={health.state} />
      <span>{health.sentence}</span>
      <NextStep pipelineId={pipelineId} next={health.next} />
      <span className="muted">
        Last snapshot <When iso={summary.snapshot ? (summary.snapshot.finishedAt ?? summary.snapshot.requestedAt) : null} />
        {" · "}
        {summary.schedule ? (
          <>
            Next <When iso={summary.schedule.nextRunAt} />
          </>
        ) : (
          "No schedule"
        )}
      </span>
    </div>
  );
}

/** Loaders (writers) left out because they belong to other processes. Removable while trying a pipeline. */
function Exclusions({ patterns, onRemove }: { patterns: string[]; onRemove?: (pattern: string) => void }) {
  if (patterns.length === 0) return null;
  return (
    <div className="exclusions">
      <Label>Ignored loaders</Label>
      <Tokenizer readonly={!onRemove} onTokenDelete={(e) => e.detail.tokens.forEach((t) => t.text && onRemove?.(t.text))}>
        {patterns.map((p) => (
          <Token key={p} text={p} />
        ))}
      </Tokenizer>
    </div>
  );
}

function SaveDialog(props: {
  tenantId: string;
  output: string;
  excludeWriters: string[];
  suggestedName: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const navigate = useNavigate();
  const save = useSavePipeline(props.tenantId);
  const saved = usePipelines(props.tenantId);
  const [name, setName] = useState(props.suggestedName);
  const same = saved.data?.filter((p) => `${p.output.space}.${p.output.technicalName}` === props.output) ?? [];
  const submit = () =>
    save.mutate({ name: name.trim(), output: props.output, excludeWriters: props.excludeWriters }, { onSuccess: (p) => props.onSaved(p.id) });

  return (
    <Dialog
      headerText="Save pipeline"
      onClose={props.onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" onClick={submit} disabled={!name.trim() || save.isPending}>
            Save
          </Button>
          <Button design="Transparent" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <Label for="pipeline-name" required>
          Name
        </Label>
        <Input id="pipeline-name" value={name} maxlength={NAME_MAX} placeholder="What it delivers, e.g. Monthly sales by region" onInput={(e) => setName(e.target.value)} />
        <p className="muted">
          A name the business knows it by. It tests the output <span className="mono">{props.output}</span>
          {props.excludeWriters.length > 0 && <>, without the ignored loaders</>}. The steps are worked out again from each new scan, so the pipeline
          follows the tenant as it changes.
        </p>
        {same.length > 0 && (
          <MessageStrip design="Critical" hideCloseButton>
            {same.length === 1 ? (
              <>
                <Link
                  href={`/pipelines/${same[0].id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/pipelines/${same[0].id}`);
                  }}
                >
                  {same[0].name}
                </Link>{" "}
                already tests this output.
              </>
            ) : (
              <>{same.length} saved pipelines already test this output: {same.map((p) => p.name).join(", ")}.</>
            )}{" "}
            Save another only to test it with other loaders ignored.
          </MessageStrip>
        )}
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
