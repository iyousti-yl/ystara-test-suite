import { useMemo, useState } from "react";
import { Label, MessageStrip, Option, Panel, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Tag, Title } from "@ui5/webcomponents-react";
import { refKey, type ColumnComparison, type StepNotCompared, type StepState, type Verdict } from "@ystara/shared";
import { useParams, useSearchParams } from "react-router";
import { useComparison, useSavedPipeline, useSnapshots, type SnapshotComparisonJson, type SnapshotJson } from "../api";
import { monoColumnWidth } from "../columns";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { counted, formatDateTimesApart, formatDifference, formatExact, formatNumber } from "../format";
import { LineageGraph } from "../lineage/LineageGraph";
import { lineageModel, MARK_LABEL, notMeasurableLabel, stepMarks } from "../lineage/model";
import { typeLabel } from "../objectTypes";
import { useInTenant } from "../tenantScope";
import { useDarkMode } from "../theme";

/**
 * Two snapshots of a saved pipeline compared (compareSnapshots in
 * @ystara/shared): the verdict on top, the lineage picture with the changed
 * steps marked, then the changed steps with their measures before and after,
 * the unchanged ones folded away, and the steps whose data couldn't be
 * compared. Without ?from and ?to, the latest two successful snapshots.
 */
export function ComparePage() {
  const { pipelineId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const pair = from && to ? { from, to } : undefined;
  const saved = useSavedPipeline(pipelineId);
  const snapshots = useSnapshots(pipelineId);
  const succeeded = snapshots.data?.filter((s) => s.status === "succeeded").length ?? 0;
  // Without a pair, wait for the list of snapshots: with fewer than two there is nothing to ask the API for.
  const tooFew = !pair && snapshots.data !== undefined && succeeded < 2;
  const comparison = useComparison(pipelineId, pair, pair !== undefined || (snapshots.data !== undefined && !tooFew));
  const definition = saved.data?.definition;
  useInTenant(definition?.tenantId);

  if (saved.isPending) return <Loading />;
  if (!saved.data || !definition) return <ErrorStrip error={saved.error} />;
  const c = comparison.data;
  // A failed snapshot keeps what it measured, so it can be picked too.
  const finished = (snapshots.data ?? []).filter((s) => s.status === "succeeded" || s.status === "failed");
  const pick = (which: "from" | "to", id: string) => c && setParams({ from: which === "from" ? id : c.before.id, to: which === "to" ? id : c.after.id });

  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { label: "Pipelines", to: `/tenants/${definition.tenantId}/pipelines` },
          { label: definition.name, to: `/pipelines/${pipelineId}/snapshots` },
        ]}
        title="Compare snapshots"
        subtitle={<span className="mono">{`${definition.output.space}.${definition.output.technicalName}`}</span>}
      />
      {c && (
        <div className="compare-pickers">
          <SnapshotPicker id="compare-from" label="Before" snapshots={finished} value={c.before.id} onPick={(id) => pick("from", id)} />
          <SnapshotPicker id="compare-to" label="After" snapshots={finished} value={c.after.id} onPick={(id) => pick("to", id)} />
        </div>
      )}
      {tooFew ? (
        <MessageStrip design="Information" hideCloseButton>
          Comparing needs two successful snapshots of this pipeline, and it has {succeeded === 0 ? "none" : "one"} yet. Snapshots are taken on the
          pipeline page.
        </MessageStrip>
      ) : snapshots.error ? (
        <ErrorStrip error={snapshots.error} />
      ) : comparison.isPending ? (
        <Loading />
      ) : !c ? (
        <ErrorStrip error={comparison.error} />
      ) : (
        <ComparisonView comparison={c} saved={saved.data} />
      )}
    </div>
  );
}

function SnapshotPicker(props: { id: string; label: string; snapshots: SnapshotJson[]; value: string; onPick: (id: string) => void }) {
  const time = formatDateTimesApart(props.snapshots.map(taken));
  return (
    <div className="compare-picker">
      <Label for={props.id}>{props.label}</Label>
      <Select id={props.id} value={props.value} onChange={(e) => props.onPick(e.detail.selectedOption.value ?? "")}>
        {props.snapshots.map((s) => (
          <Option key={s.id} value={s.id}>
            {time(taken(s))}
            {s.status === "failed" ? " (failed)" : ""}
          </Option>
        ))}
      </Select>
    </div>
  );
}

function ComparisonView({ comparison: c, saved }: { comparison: SnapshotComparisonJson; saved: NonNullable<ReturnType<typeof useSavedPipeline>["data"]> }) {
  const dark = useDarkMode();
  const [selected, setSelected] = useState<string>();
  const model = useMemo(() => {
    const m = lineageModel(saved.pipeline, saved.graph, saved.measurement);
    const marks = stepMarks(c);
    return { ...m, nodes: m.nodes.map((n) => ({ ...n, mark: marks.get(n.key) })) };
  }, [saved, c]);
  const changed = c.compared.filter((o) => o.verdict !== "unchanged");
  const unchanged = c.compared.filter((o) => o.verdict === "unchanged");
  const definitionsChanged = c.definitionsOnly.filter((s) => s.definitionChanged);

  // Clicking a changed step in the picture brings its measures into view.
  const select = (key: string | undefined) => {
    setSelected(key);
    if (key) document.getElementById(anchor(key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <div className="compare-verdict">
        <VerdictTag verdict={c.verdict} large />
        <span>{summary(c)}</span>
      </div>
      {c.measuredOnce.length > 0 && (
        <MessageStrip design="Information" hideCloseButton>
          {c.measuredOnce.length === 1 ? "One step was" : `${c.measuredOnce.length} steps were`} measured in only one of the two snapshots, so{" "}
          {c.measuredOnce.length === 1 ? "its" : "their"} data isn&apos;t compared. They are listed below with the reason.
        </MessageStrip>
      )}

      <div className="compare-graph pipeline-graph">
        <LineageGraph key={`${c.before.id}-${c.after.id}`} nodes={model.nodes} edges={model.edges} selected={selected} onSelect={select} dark={dark} />
      </div>
      <p className="muted">The picture is the pipeline on the tenant&apos;s latest scan, with what changed between the two snapshots marked on each step.</p>

      {changed.length + definitionsChanged.length > 0 && (
        <section className="block">
          <Title level="H4">Changed steps</Title>
          {changed.map((o) => (
            <ChangedStep key={refKey(o)} step={o} />
          ))}
          {definitionsChanged.map((s) => (
            <ChangedDefinition key={refKey(s)} step={s} />
          ))}
        </section>
      )}
      {unchanged.length > 0 && (
        <Panel collapsed fixed={false} headerText={counted(unchanged.length, "unchanged step")} className="block">
          <ul className="steps">
            {unchanged.map((o) => (
              <li key={refKey(o)}>
                <span className="mono">{o.technicalName}</span> <span className="muted">{typeLabel(o.type)}</span>: {formatNumber(o.rows.after)} rows, every
                measure the same
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {c.measuredOnce.length > 0 && (
        <section className="block">
          <Title level="H4">Measured in only one snapshot</Title>
          <NotComparedTable steps={c.measuredOnce} />
        </section>
      )}
      {(c.added.length > 0 || c.removed.length > 0) && (
        <section className="block">
          <Title level="H4">Steps added or removed</Title>
          <p className="muted">The pipeline itself changed between the two snapshots.</p>
          <ul className="steps">
            {c.added.map((s) => (
              <li key={refKey(s)}>
                New: <span className="mono">{s.technicalName}</span> <span className="muted">{typeLabel(s.type)}</span>
              </li>
            ))}
            {c.removed.map((s) => (
              <li key={refKey(s)}>
                Removed: <span className="mono">{s.technicalName}</span> <span className="muted">{typeLabel(s.type)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {c.definitionsOnly.length > 0 && (
        <Panel collapsed fixed={false} headerText={`${counted(c.definitionsOnly.length, "step")} not measured`} className="block">
          <p className="muted panel-intro">
            These steps have no data SQL can measure, in either snapshot. Their definitions are still compared
            {definitionsChanged.length > 0 ? `: ${definitionsChanged.length} changed, shown above.` : ", and none changed."}
          </p>
          <DefinitionsTable steps={c.definitionsOnly} />
        </Panel>
      )}
    </>
  );
}

const VERDICT: Record<Verdict, { design: "Positive" | "Critical" | "Information" | "Negative"; label: string }> = {
  unchanged: { design: "Positive", label: "Unchanged" },
  data_changed: { design: "Critical", label: "Data changed" },
  definition_changed: { design: "Information", label: "Definition changed" },
  both: { design: "Negative", label: "Data and definition changed" },
};

function VerdictTag({ verdict, large }: { verdict: Verdict; large?: boolean }) {
  return (
    <Tag design={VERDICT[verdict].design} className={large ? "verdict-large" : undefined}>
      {VERDICT[verdict].label}
    </Tag>
  );
}

/** One line on what the verdict rests on. */
function summary(c: SnapshotComparisonJson): string {
  const dataChanged = c.compared.filter((o) => o.verdict === "data_changed" || o.verdict === "both").length;
  const definitions = [...c.compared, ...c.measuredOnce, ...c.definitionsOnly].filter((s) => s.definitionChanged).length;
  const n = c.compared.length;
  const parts = [
    n === 0
      ? "No step was measured in both"
      : dataChanged
        ? `Data changed in ${dataChanged} of ${counted(n, "measured step")}`
        : `No data changed in ${n === 1 ? "the measured step" : `the ${n} measured steps`}`,
  ];
  if (definitions) parts.push(`${definitions} ${definitions === 1 ? "definition" : "definitions"} changed`);
  if (c.added.length || c.removed.length) parts.push(`${c.added.length} added, ${c.removed.length} removed`);
  if (c.measuredOnce.length) parts.push(`${c.measuredOnce.length} not compared`);
  const time = formatDateTimesApart([taken(c.before), taken(c.after)]);
  return `${parts.join(" · ")}. From ${time(taken(c.before))} to ${time(taken(c.after))}.`;
}

/** When a snapshot was taken, as the list of snapshots shows it. */
const taken = (s: SnapshotJson) => s.finishedAt ?? s.requestedAt;

const anchor = (key: string) => `step-${key}`;

/** A step measured in both whose data or definition changed: rows, the set of columns, then each changed column. */
function ChangedStep({ step: o }: { step: SnapshotComparisonJson["compared"][number] }) {
  const changedColumns = o.columns.filter((col) => col.changed);
  const same = o.columns.length - changedColumns.length;
  return (
    <div className="compare-step" id={anchor(refKey(o))}>
      <div className="compare-step-head">
        <span className="mono compare-step-name">{o.technicalName}</span>
        <span className="muted">{typeLabel(o.type)}</span>
        <VerdictTag verdict={o.verdict} />
      </div>
      <ul className="compare-facts">
        {o.definitionChanged && <li>Its definition changed between the two scans the snapshots used.</li>}
        <li>
          Rows: {formatNumber(o.rows.before)} → {formatNumber(o.rows.after)}
          {o.rows.difference !== 0 && <span className="compare-difference"> {formatDifference(o.rows.difference, o.rows.percent)}</span>}
        </li>
        {o.columnsAdded.length > 0 && (
          <li>
            Columns added: <span className="mono">{o.columnsAdded.join(", ")}</span>
          </li>
        )}
        {o.columnsRemoved.length > 0 && (
          <li>
            Columns removed: <span className="mono">{o.columnsRemoved.join(", ")}</span>
          </li>
        )}
      </ul>
      {changedColumns.length > 0 && <ColumnChanges columns={changedColumns} />}
      {same > 0 && (
        <p className="muted">
          {changedColumns.length > 0 ? `The other ${same}` : `All ${same}`} {same === 1 ? "column has" : "columns have"} the same measures.
        </p>
      )}
    </div>
  );
}

/** A step measured in neither snapshot whose definition changed: all a comparison can say about it. */
function ChangedDefinition({ step: s }: { step: StepNotCompared }) {
  return (
    <div className="compare-step" id={anchor(refKey(s))}>
      <div className="compare-step-head">
        <span className="mono compare-step-name">{s.technicalName}</span>
        <span className="muted">{typeLabel(s.type)}</span>
        <VerdictTag verdict="definition_changed" />
      </div>
      <ul className="compare-facts">
        <li>Its definition changed between the two scans the snapshots used.</li>
        <li>
          Its data isn&apos;t measured: <StateLabel state={s.after} />
        </li>
      </ul>
    </div>
  );
}

/** Before → after for each measure; min, max and small sums only as changed or not, since only their hashes are stored. */
function ColumnChanges({ columns }: { columns: ColumnComparison[] }) {
  return (
    <Table
      overflowMode="Popin"
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell minWidth={monoColumnWidth(columns.map((col) => col.name))} importance={2}>
            Column
          </TableHeaderCell>
          <TableHeaderCell minWidth="10rem" importance={1}>
            Non-null
          </TableHeaderCell>
          <TableHeaderCell minWidth="10rem">Distinct</TableHeaderCell>
          <TableHeaderCell minWidth="12rem">Sum</TableHeaderCell>
          <TableHeaderCell minWidth="7rem">Min / max</TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {columns.map((col) => (
        <TableRow key={col.name} rowKey={col.name}>
          <TableCell>
            <span>
              <span className="mono">{col.name}</span>{" "}
              <span className="muted">{col.dataType.before === col.dataType.after ? col.dataType.after : `${col.dataType.before} → ${col.dataType.after}`}</span>
            </span>
          </TableCell>
          <TableCell>
            <Change before={formatNumber(col.nonNull.before)} after={formatNumber(col.nonNull.after)} difference={col.nonNull.difference ? formatDifference(col.nonNull.difference, col.nonNull.percent) : undefined} />
          </TableCell>
          <TableCell>
            {col.distinct ? (
              <Change before={formatNumber(col.distinct.before)} after={formatNumber(col.distinct.after)} difference={col.distinct.difference ? formatDifference(col.distinct.difference, col.distinct.percent) : undefined} />
            ) : (
              "–"
            )}
          </TableCell>
          <TableCell>
            {col.sum ? (
              <Change
                before={formatExact(col.sum.before)}
                after={formatExact(col.sum.after)}
                difference={col.sum.changed && col.sum.difference !== null ? formatDifference(col.sum.difference, col.sum.percent) : col.sum.changed ? "changed" : undefined}
              />
            ) : col.sumHash ? (
              <HashResult change={col.sumHash} what="Sum" />
            ) : (
              "–"
            )}
          </TableCell>
          <TableCell>
            {col.min || col.max ? (
              <span>
                {col.min && <HashResult change={col.min} what="Min" />}
                {col.min && col.max && " · "}
                {col.max && <HashResult change={col.max} what="Max" />}
              </span>
            ) : (
              "–"
            )}
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

function Change({ before, after, difference }: { before: string; after: string; difference?: string }) {
  if (!difference) return <span className="muted">{after}</span>;
  return (
    <span>
      {before} → {after} <span className="compare-difference">{difference}</span>
    </span>
  );
}

const HashResult = ({ change, what }: { change: "changed" | "unchanged"; what: string }) => (
  <span className={change === "changed" ? "compare-difference" : "muted"}>
    {what} {change}
  </span>
);

/** Steps whose data wasn't compared: how each snapshot ended for them, and whether their definition changed. */
function NotComparedTable({ steps }: { steps: StepNotCompared[] }) {
  return (
    <Table
      overflowMode="Popin"
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell minWidth={monoColumnWidth(steps.map((s) => s.technicalName))} importance={2}>
            Step
          </TableHeaderCell>
          <TableHeaderCell minWidth="10rem">Before</TableHeaderCell>
          <TableHeaderCell minWidth="10rem">After</TableHeaderCell>
          <TableHeaderCell minWidth="8rem" importance={1}>
            Definition
          </TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {steps.map((s) => (
        <TableRow key={refKey(s)} rowKey={refKey(s)}>
          <TableCell>
            <span>
              <span className="mono">{s.technicalName}</span> <span className="muted">{typeLabel(s.type)}</span>
            </span>
          </TableCell>
          <TableCell>
            <StateLabel state={s.before} />
          </TableCell>
          <TableCell>
            <StateLabel state={s.after} />
          </TableCell>
          <TableCell>{s.definitionChanged ? <span className="compare-difference">{MARK_LABEL.definition_changed}</span> : <span className="muted">Unchanged</span>}</TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

/** Steps measured in neither snapshot: why, and whether their definition changed. */
function DefinitionsTable({ steps }: { steps: StepNotCompared[] }) {
  return (
    <Table
      overflowMode="Popin"
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell minWidth={monoColumnWidth(steps.map((s) => s.technicalName))} importance={2}>
            Step
          </TableHeaderCell>
          <TableHeaderCell minWidth="14rem">Not measured because</TableHeaderCell>
          <TableHeaderCell minWidth="8rem" importance={1}>
            Definition
          </TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {steps.map((s) => (
        <TableRow key={refKey(s)} rowKey={refKey(s)}>
          <TableCell>
            <span>
              <span className="mono">{s.technicalName}</span> <span className="muted">{typeLabel(s.type)}</span>
            </span>
          </TableCell>
          <TableCell>
            <span>
              <StateLabel state={s.after} />
              {(s.before.status !== s.after.status || s.before.reason !== s.after.reason) && (
                <span className="muted">
                  {" "}
                  (before: <StateLabel state={s.before} />)
                </span>
              )}
            </span>
          </TableCell>
          <TableCell>{s.definitionChanged ? <span className="compare-difference">{MARK_LABEL.definition_changed}</span> : <span className="muted">Unchanged</span>}</TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

function StateLabel({ state }: { state: StepState }) {
  if (state.status === "measured") return <span>Measured</span>;
  if (state.status === "failed") return <span className="text-negative">Failed: {state.reason}</span>;
  return <span className="muted">{notMeasurableLabel(state.reason as Parameters<typeof notMeasurableLabel>[0])}</span>;
}
