import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Label,
  MessageStrip,
  Option,
  Panel,
  Select,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Tag,
  TextArea,
  Title,
} from "@ui5/webcomponents-react";
import { refKey, toScenarioYaml, whyNoScenarioRun, type Assertion, type Expectation, type Fixture, type ObjectType, type ScenarioInputs, type ScenarioSpec, type ScenarioStepNote } from "@ystara/shared";
import { useBeforeUnload, useBlocker, useNavigate, useParams } from "react-router";
import {
  useCan,
  useDatabaseUsers,
  useDeleteScenario,
  useRunScenario,
  useSavedPipeline,
  useSaveScenario,
  useScenario,
  useScenarioCompile,
  useScenarioInputs,
  useScenarioRun,
  useScenarioRuns,
  useScenarios,
  useTenant,
  type ScenarioDraft,
  type ScenarioJson,
  type ScenarioRunJson,
} from "../api";
import { monoColumnWidth } from "../columns";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { counted, formatDateTime, formatDateTimesApart } from "../format";
import { typeLabel } from "../objectTypes";
import { CheckDialog, type Checkpoint } from "../scenario/CheckDialog";
import { assertionLabel, cellFromText, gridFromRows, rowsFromGrid, type Grid } from "../scenario/model";
import { RowsGrid } from "../scenario/RowsGrid";
import { useInTenant } from "../tenantScope";

/**
 * Scenarios (phase 3b): a saved pipeline's test cases, built in the app. A
 * scenario gives test rows for the pipeline's tables and the checks expected
 * at its steps; the builder compiles it as it changes (nothing is sent to the
 * tenant), and a run sends each check as one SELECT that reads only those rows.
 * The same scenario can be read as a scenario file (YAML) for Git or the CLI.
 */

const KINDS: { kind: ScenarioSpec["kind"]; label: string }[] = [
  { kind: "golden", label: "Golden: the normal case, with known results" },
  { kind: "common", label: "Common: a frequent variation" },
  { kind: "outlying", label: "Outlying: an edge case" },
];
const kindLabel = (kind: string) => kind[0].toUpperCase() + kind.slice(1);

const RUN_STATUS = {
  queued: { design: "Information", label: "Queued" },
  running: { design: "Information", label: "Running" },
  passed: { design: "Positive", label: "Passed" },
  failed: { design: "Negative", label: "Failed" },
  error: { design: "Critical", label: "Couldn't run" },
} as const;

export function RunStatusTag({ status }: { status: ScenarioRunJson["status"] }) {
  const s = RUN_STATUS[status];
  return <Tag design={s.design}>{s.label}</Tag>;
}

const CHECK_STATUS = {
  pass: { design: "Positive", label: "Pass" },
  fail: { design: "Negative", label: "Fail" },
  error: { design: "Critical", label: "Error" },
  not_run: { design: "Neutral", label: "Not run" },
} as const;

const checkCount = (spec: ScenarioSpec) => spec.expect.reduce((n, e) => n + e.assertions.length, 0);

/** The Scenarios tab of a saved pipeline: its scenarios by name, with the latest run of each. */
export function ScenariosSection({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const can = useCan();
  const scenarios = useScenarios(pipelineId);
  return (
    <section className="block">
      <div className="list-toolbar section-toolbar">
        <Title level="H4">{scenarios.data ? counted(scenarios.data.length, "scenario") : "Scenarios"}</Title>
        {can("scenarios.write_visual") && (
          <Button design="Emphasized" icon="add" onClick={() => navigate(`/pipelines/${pipelineId}/scenarios/new`)}>
            New scenario
          </Button>
        )}
      </div>
      <p className="muted page-intro">
        A scenario gives test rows to the pipeline&apos;s tables and says what to expect at its steps. It runs on those rows only, compiled from the
        definitions of the latest scan: nothing is written to the tenant and none of its data is read.
      </p>
      <ErrorStrip error={scenarios.error} />
      <Table
        loading={scenarios.isPending}
        noDataText={can("scenarios.write_visual") ? "No scenarios yet. Make one with New scenario." : "No scenarios yet."}
        overflowMode="Popin"
        onRowClick={(e) => navigate(`/scenarios/${e.detail.row.rowKey}`)}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="14rem" importance={1}>
              Scenario
            </TableHeaderCell>
            <TableHeaderCell minWidth="6rem">Kind</TableHeaderCell>
            <TableHeaderCell minWidth="5rem" horizontalAlign="End">
              Checks
            </TableHeaderCell>
            <TableHeaderCell minWidth="12rem" importance={1}>
              Latest run
            </TableHeaderCell>
            <TableHeaderCell minWidth="12rem">Saved</TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {scenarios.data?.map((s) => (
          <TableRow key={s.id} rowKey={s.id} interactive>
            <TableCell>
              <span>
                {s.name}
                {s.spec.description && <span className="muted scenario-description">{s.spec.description}</span>}
              </span>
            </TableCell>
            <TableCell>{kindLabel(s.spec.kind)}</TableCell>
            <TableCell horizontalAlign="End">{checkCount(s.spec)}</TableCell>
            <TableCell>
              {s.lastRun ? (
                <span className="facts">
                  <RunStatusTag status={s.lastRun.status} />
                  {s.lastRun.total !== null && (
                    <span>
                      {s.lastRun.passed} of {s.lastRun.total} passed
                    </span>
                  )}
                </span>
              ) : (
                <span className="muted">Never run</span>
              )}
            </TableCell>
            <TableCell>
              {formatDateTime(s.updatedAt)}
              {s.updatedBy && <span className="muted"> by {s.updatedBy}</span>}
            </TableCell>
          </TableRow>
        ))}
      </Table>
    </section>
  );
}

/**
 * The builder: /pipelines/:pipelineId/scenarios/new for a new scenario,
 * /scenarios/:scenarioId for a saved one. Those who can't build tests see it
 * read-only, with its runs.
 */
export function ScenarioPage() {
  const { pipelineId: pipelineParam = "", scenarioId = "" } = useParams();
  const scenario = useScenario(scenarioId);
  const pipelineId = scenarioId ? (scenario.data?.pipelineId ?? "") : pipelineParam;
  const pipeline = useSavedPipeline(pipelineId);
  const inputs = useScenarioInputs(pipelineId);
  useInTenant(pipeline.data?.definition.tenantId);

  if (scenarioId && !scenario.data) return scenario.isPending ? <Loading /> : <ErrorStrip error={scenario.error} />;
  if (!pipeline.data || !inputs.data) return pipeline.isPending || inputs.isPending ? <Loading /> : <ErrorStrip error={pipeline.error ?? inputs.error} />;
  return (
    <Builder
      // A saved scenario starts again from what was saved.
      key={scenario.data?.updatedAt ?? "new"}
      pipelineId={pipelineId}
      pipelineName={pipeline.data.definition.name}
      output={refKey(pipeline.data.definition.output)}
      tenantId={pipeline.data.definition.tenantId}
      inputs={inputs.data}
      saved={scenario.data}
    />
  );
}

/** A table that takes rows, or a fixture the scenario has for a table the builder doesn't offer (written by hand). */
interface RowsTable {
  key: string;
  technicalName: string;
  type: ObjectType | null;
  why: string | null;
}

/** What the builder edits, from the saved scenario (or a new one) and what the pipeline offers. */
function startingPoint(inputs: ScenarioInputs, saved: ScenarioJson | undefined) {
  const spec = saved?.spec;
  const resolve = <T extends { space: string; technicalName: string }>(list: T[], name: string) =>
    list.find((x) => refKey(x) === name) ?? (list.filter((x) => x.technicalName === name).length === 1 ? list.find((x) => x.technicalName === name) : undefined);

  const tables: RowsTable[] = inputs.tables.map((t) => ({ key: refKey(t), technicalName: t.technicalName, type: t.type, why: t.why }));
  const grids: Record<string, Grid> = Object.fromEntries(inputs.tables.map((t) => [refKey(t), { columns: t.columns, rows: [] }]));
  const kept: Fixture[] = [];
  for (const f of spec?.fixtures ?? []) {
    if (f.csv) {
      kept.push(f); // not edited here; the compile check says CSV isn't supported yet
      continue;
    }
    const table = resolve(inputs.tables, f.table);
    const key = table ? refKey(table) : f.table;
    if (!table) tables.push({ key, technicalName: f.table, type: null, why: null });
    grids[key] = gridFromRows(table?.columns ?? [], f.rows ?? []);
  }
  // Checkpoints by SPACE.NAME, so one stays the same step whatever the scenario file called it.
  const expect: Expectation[] = (spec?.expect ?? []).map((e) => {
    const step = resolve(inputs.checkpoints, e.checkpoint);
    return { checkpoint: step ? refKey(step) : e.checkpoint, assertions: e.assertions };
  });
  return {
    name: spec?.name ?? "",
    kind: spec?.kind ?? "golden",
    description: spec?.description ?? "",
    tags: spec?.tags ?? [],
    tables,
    grids,
    kept,
    expect,
  };
}

type Start = ReturnType<typeof startingPoint>;

/**
 * The scenario as the API takes it. Only tables with rows get a fixture (a
 * table without one is empty); a scenario needs one, so with no rows at all
 * the first table gets an empty one.
 */
function draftOf(s: Omit<Start, "tables"> & { tables: RowsTable[] }): ScenarioDraft {
  const fixtures: Fixture[] = s.tables.filter((t) => s.grids[t.key].rows.length > 0).map((t) => ({ table: t.key, rows: rowsFromGrid(s.grids[t.key]) }));
  fixtures.push(...s.kept);
  if (!fixtures.length && s.tables.length) fixtures.push({ table: s.tables[0].key, rows: [] });
  return {
    name: s.name.trim(),
    kind: s.kind,
    ...(s.description.trim() ? { description: s.description.trim() } : {}),
    tags: s.tags,
    fixtures,
    expect: s.expect,
  };
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Builder(props: { pipelineId: string; pipelineName: string; output: string; tenantId: string; inputs: ScenarioInputs; saved: ScenarioJson | undefined }) {
  const { pipelineId, inputs, saved } = props;
  const navigate = useNavigate();
  const can = useCan();
  const editable = can("scenarios.write_visual");
  const start = useMemo(() => startingPoint(inputs, saved), [inputs, saved]);
  const [name, setName] = useState(start.name);
  const [kind, setKind] = useState(start.kind);
  const [description, setDescription] = useState(start.description);
  const [grids, setGrids] = useState(start.grids);
  const [expect, setExpect] = useState(start.expect);
  const [editing, setEditing] = useState<{ expectation: number; assertion: number } | { checkpoint: string } | undefined>();
  const save = useSaveScenario(pipelineId, saved?.id);
  const remove = useDeleteScenario(pipelineId);
  const run = useRunScenario(pipelineId, saved?.id ?? "");
  const tenant = useTenant(props.tenantId);
  const databaseUsers = useDatabaseUsers(props.tenantId);
  // Why no scenario of this tenant can run (an imported tenant, no connected database user), once both are known.
  const whyNoRun = tenant.data && databaseUsers.data ? whyNoScenarioRun(databaseUsers.data, tenant.data.host !== null) : undefined;

  const draft = useMemo(
    () => draftOf({ ...start, name, kind, description, grids, expect }),
    [start, name, kind, description, grids, expect],
  );
  const initial = useMemo(() => JSON.stringify(draftOf(start)), [start]);
  const dirty = JSON.stringify(draft) !== initial;
  // Compiled once the draft has a check; a name isn't needed for that.
  const settled = useSettled(draft, 500);
  const compile = useScenarioCompile(pipelineId, settled.expect.length ? { ...settled, name: settled.name || "Unsaved scenario" } : undefined);
  const compiled = compile.data;

  const invalidCells = Object.values(grids).reduce(
    (n, g) => n + g.rows.reduce((m, r) => m + g.columns.filter((c) => cellFromText(r[c.name] ?? "", c.type).invalid).length, 0),
    0,
  );
  const whyNotSave = !name.trim()
    ? "Give the scenario a name"
    : !expect.length
      ? "Add a check"
      : invalidCells
        ? `${counted(invalidCells, "cell")} ${invalidCells === 1 ? "doesn't" : "don't"} fit the column's type`
        : !dirty && saved
          ? "No changes to save"
          : undefined;
  const whyNotRun = whyNoRun ?? (dirty ? "Save the changes first" : compiled?.problems.length ? "The scenario has problems: see above" : undefined);

  // Leaving with changes asks first, unless the page is leaving because of a save or a delete.
  const leaving = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !leaving.current && dirty && editable && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Leave without saving? The changes to this scenario are lost.")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useBeforeUnload((e) => {
    if (dirty && editable) e.preventDefault();
  });

  const checkpoints: Checkpoint[] = inputs.checkpoints.map((c) => ({ key: refKey(c), technicalName: c.technicalName, type: typeLabel(c.type), columns: c.columns }));
  // A new check starts on the output, or on the last step a check can be on.
  const firstCheckpoint = checkpoints.find((c) => c.key === props.output)?.key ?? checkpoints.at(-1)?.key ?? "";
  const stepName = (key: string) => checkpoints.find((c) => c.key === key)?.technicalName ?? key;

  /** The flat position of each check, as the compile check numbers them. */
  let position = 0;
  const numbered = expect.map((e) => e.assertions.map(() => position++));

  const putCheck = (checkpoint: string, assertion: Assertion) => {
    setExpect((current) => {
      let next = current.map((e) => ({ ...e, assertions: [...e.assertions] }));
      if (editing && "expectation" in editing) {
        const from = next[editing.expectation];
        if (from.checkpoint === checkpoint) {
          from.assertions[editing.assertion] = assertion;
          return next;
        }
        from.assertions.splice(editing.assertion, 1);
        next = next.filter((e) => e.assertions.length);
      }
      const at = next.findIndex((e) => e.checkpoint === checkpoint);
      if (at >= 0) next[at].assertions.push(assertion);
      else next.push({ checkpoint, assertions: [assertion] });
      return next;
    });
    setEditing(undefined);
  };
  const removeCheck = (expectation: number, assertion: number) =>
    setExpect((current) =>
      current.map((e, i) => (i === expectation ? { ...e, assertions: e.assertions.filter((_, k) => k !== assertion) } : e)).filter((e) => e.assertions.length),
    );

  const submit = () =>
    save.mutate(draft, {
      onSuccess: (s) => {
        if (!saved) {
          leaving.current = true;
          navigate(`/scenarios/${s.id}`, { replace: true });
        }
      },
    });

  // In the order a scenario file has its fields (ScenarioSpec in @ystara/shared).
  const spec = {
    version: 1,
    name: draft.name,
    ...(draft.description ? { description: draft.description } : {}),
    kind: draft.kind,
    pipeline: props.output,
    ...(draft.tags?.length ? { tags: draft.tags } : {}),
    fixtures: draft.fixtures,
    expect: draft.expect,
  } as ScenarioSpec;

  return (
    <div className="page page-wide">
      <PageHeader
        crumbs={[
          { label: "Pipelines", to: `/tenants/${props.tenantId}/pipelines` },
          { label: props.pipelineName, to: `/pipelines/${pipelineId}/scenarios` },
        ]}
        title={saved ? saved.name : "New scenario"}
        subtitle={
          <span className="facts">
            <span>{saved ? `Saved ${formatDateTime(saved.updatedAt)}${saved.updatedBy ? ` by ${saved.updatedBy}` : ""}` : "Not saved yet"}</span>
            {dirty && editable && saved && <Tag design="Critical">Unsaved changes</Tag>}
            <span>Compiled on the latest successful scan</span>
          </span>
        }
        actions={
          <>
            {editable && (
              <Button design="Emphasized" icon="save" disabled={!!whyNotSave || save.isPending} tooltip={whyNotSave} onClick={submit}>
                Save
              </Button>
            )}
            {saved && can("runs.execute") && (
              <Button
                icon="media-play"
                disabled={!!whyNotRun || run.isPending}
                tooltip={whyNotRun ?? "Run the checks on this scenario's rows"}
                onClick={() => run.mutate(undefined, { onSuccess: (r) => navigate(`/scenario-runs/${r.id}`) })}
              >
                Run
              </Button>
            )}
            {saved && editable && (
              <Button
                design="Transparent"
                icon="delete"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Delete the scenario "${saved.name}" and its runs? Nothing changes in Datasphere.`)) {
                    leaving.current = true;
                    remove.mutate(saved.id, { onSuccess: () => navigate(`/pipelines/${pipelineId}/scenarios`) });
                  }
                }}
              >
                Delete
              </Button>
            )}
          </>
        }
      />
      <ErrorStrip error={save.error ?? run.error ?? remove.error} />

      <section className="block scenario-about">
        <div className="scenario-field">
          <Label for="scenario-name" required>
            Name
          </Label>
          <Input id="scenario-name" value={name} readonly={!editable} placeholder="Closed orders are left out" onInput={(e) => setName(e.target.value)} />
        </div>
        <div className="scenario-field">
          <Label for="scenario-kind">Kind</Label>
          <Select id="scenario-kind" readonly={!editable} onChange={(e) => setKind(e.detail.selectedOption.value as ScenarioSpec["kind"])}>
            {KINDS.map((k) => (
              <Option key={k.kind} value={k.kind} selected={k.kind === kind}>
                {k.label}
              </Option>
            ))}
          </Select>
        </div>
        <div className="scenario-field scenario-field-wide">
          <Label for="scenario-description">Description</Label>
          <TextArea
            id="scenario-description"
            value={description}
            readonly={!editable}
            rows={2}
            growing
            placeholder="What this scenario shows, in a sentence"
            onInput={(e) => setDescription(e.target.value)}
          />
        </div>
      </section>

      <section className="block">
        <Title level="H4">Test rows</Title>
        <p className="muted page-intro">
          These rows stand in for the pipeline&apos;s tables. A table you give no rows is empty in this scenario. Use made-up values, not rows copied from the
          tenant: the scenario is stored in Ystara.
        </p>
        {start.tables.length === 0 && (
          <MessageStrip design="Critical" hideCloseButton>
            No table of this pipeline takes rows: every one is loaded by a step that can&apos;t be compiled. The steps below say why.
          </MessageStrip>
        )}
        {start.tables.map((t) => (
          <div className="scenario-table" key={t.key}>
            <div className="scenario-table-head">
              <span className="mono scenario-table-name">{t.technicalName}</span>
              {t.type && <span className="muted">{typeLabel(t.type)}</span>}
              <span className="muted">{t.why ? `Takes rows: ${t.why}.` : "Not a table the builder offers rows for; kept as the scenario had it."}</span>
              <span className="muted">{counted(grids[t.key].rows.length, "row")}</span>
            </div>
            {grids[t.key].rows.length === 0 && !editable ? (
              <p className="muted">No rows: the table is empty in this scenario.</p>
            ) : (
              <RowsGrid label={`Rows of ${t.technicalName}`} grid={grids[t.key]} readOnly={!editable} onChange={(g) => setGrids((all) => ({ ...all, [t.key]: g }))} />
            )}
          </div>
        ))}
        {start.kept.map((f) => (
          <MessageStrip key={f.table} design="Information" hideCloseButton>
            The rows of <span className="mono">{f.table}</span> come from a CSV file, which the builder doesn&apos;t edit. They are kept as they are.
          </MessageStrip>
        ))}
      </section>

      <section className="block">
        <div className="list-toolbar section-toolbar">
          <Title level="H4">Checks</Title>
          {editable && checkpoints.length > 0 && (
            <Button icon="add" onClick={() => setEditing({ checkpoint: firstCheckpoint })}>
              Add check
            </Button>
          )}
        </div>
        <CompileStrip compiled={compiled} error={compile.error} empty={!expect.length} busy={compile.isFetching} />
        {expect.length === 0 && <p className="muted">No checks yet. A check says what a step should give for these rows, such as its number of rows.</p>}
        {expect.map((e, i) => (
          <div className="scenario-checks" key={`${e.checkpoint}-${i}`}>
            <div className="scenario-table-head">
              <span className="mono scenario-table-name">{stepName(e.checkpoint)}</span>
              <span className="muted">{checkpoints.find((c) => c.key === e.checkpoint)?.type ?? "not a step of the pipeline"}</span>
            </div>
            <ul className="item-list check-list">
              {e.assertions.map((a, k) => {
                const problem = compiled?.checks[numbered[i][k]]?.problem;
                return (
                  <li key={k}>
                    <span className="mono">{assertionLabel(a)}</span>
                    {problem ? <span className="text-negative">{problem}</span> : compiled && !compiled.problems.length && <span className="muted">Compiles</span>}
                    {editable && (
                      <span className="check-actions">
                        <Button design="Transparent" icon="edit" tooltip="Change" accessibleName="Change" onClick={() => setEditing({ expectation: i, assertion: k })} />
                        <Button design="Transparent" icon="delete" tooltip="Remove" accessibleName="Remove" onClick={() => removeCheck(i, k)} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <Panel className="block" headerText="How each step is simulated" collapsed>
        <StepsTable steps={compiled?.steps ?? inputs.steps} />
      </Panel>

      <Panel className="block" headerText="As a scenario file (YAML)" collapsed>
        <p className="muted">
          The same scenario as a file for Git or <span className="mono">npm run scenario:run</span>. Save it as a <span className="mono">.local.yaml</span>{" "}
          file: test rows stay out of the repository.
        </p>
        <Button icon="copy" onClick={() => void navigator.clipboard.writeText(toScenarioYaml(spec))}>
          Copy
        </Button>
        <pre className="cli-output scenario-yaml">{toScenarioYaml(spec)}</pre>
      </Panel>

      {saved && <RunsSection scenarioId={saved.id} whyNoRun={can("runs.execute") ? whyNoRun : undefined} />}

      {editing && checkpoints.length > 0 && (
        <CheckDialog
          checkpoints={checkpoints}
          initial={"expectation" in editing ? { checkpoint: expect[editing.expectation].checkpoint, assertion: expect[editing.expectation].assertions[editing.assertion] } : editing}
          onSave={putCheck}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

/** Whether the draft compiles, in a line: the problems that stop it, or how many checks are ready. */
function CompileStrip({ compiled, error, empty, busy }: { compiled: ScenarioCompileJson | undefined; error: Error | null; empty: boolean; busy: boolean }) {
  if (empty) return null;
  if (error) return <ErrorStrip error={error} />;
  if (!compiled) return busy ? <p className="muted">Compiling…</p> : null;
  if (compiled.problems.length)
    return (
      <MessageStrip design="Negative" hideCloseButton>
        The scenario can&apos;t run yet. {compiled.problems.join(" ")}
      </MessageStrip>
    );
  const ready = compiled.checks.filter((c) => !c.problem).length;
  return (
    <MessageStrip design={ready === compiled.checks.length ? "Positive" : "Critical"} hideCloseButton>
      {ready === compiled.checks.length
        ? `It compiles: ${counted(ready, "check")} ready to run.`
        : `${ready} of ${counted(compiled.checks.length, "check")} can run. The others say why.`}{" "}
      Compiled from the definitions alone; nothing was sent to the tenant.
    </MessageStrip>
  );
}

type ScenarioCompileJson = NonNullable<ReturnType<typeof useScenarioCompile>["data"]>;

function StepsTable({ steps }: { steps: ScenarioStepNote[] }) {
  return (
    <Table
      overflowMode="Popin"
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell minWidth={monoColumnWidth(steps.map((s) => s.technicalName))} importance={1}>
            Step
          </TableHeaderCell>
          <TableHeaderCell minWidth="14rem">Stands in</TableHeaderCell>
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
              {s.note}
              {s.problem && <span className="text-negative">: {s.problem}</span>}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

function RunsSection({ scenarioId, whyNoRun }: { scenarioId: string; whyNoRun: string | undefined }) {
  const navigate = useNavigate();
  const runs = useScenarioRuns(scenarioId);
  const time = formatDateTimesApart((runs.data ?? []).map((r) => r.requestedAt));
  return (
    <section className="block">
      <Title level="H4">{runs.data ? counted(runs.data.length, "run") : "Runs"}</Title>
      {whyNoRun && (
        <MessageStrip design="Information" hideCloseButton>
          This scenario can&apos;t run yet. {whyNoRun}
        </MessageStrip>
      )}
      <ErrorStrip error={runs.error} />
      <Table
        loading={runs.isPending}
        noDataText="Not run yet."
        overflowMode="Popin"
        onRowClick={(e) => navigate(`/scenario-runs/${e.detail.row.rowKey}`)}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="13rem" importance={1}>
              Asked for
            </TableHeaderCell>
            <TableHeaderCell minWidth="8rem" importance={1}>
              Status
            </TableHeaderCell>
            <TableHeaderCell minWidth="8rem" horizontalAlign="End">
              Checks passed
            </TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {runs.data?.map((r) => (
          <TableRow key={r.id} rowKey={r.id} interactive>
            <TableCell>{time(r.requestedAt)}</TableCell>
            <TableCell>
              <RunStatusTag status={r.status} />
            </TableCell>
            <TableCell horizontalAlign="End">{r.total === null ? "–" : `${r.passed} of ${r.total}`}</TableCell>
          </TableRow>
        ))}
      </Table>
    </section>
  );
}

/** One run: each check with what came back, and what stood in for each step. Refreshes while it runs. */
export function ScenarioRunPage() {
  const { runId = "" } = useParams();
  const run = useScenarioRun(runId);
  useInTenant(run.data?.tenantId);

  if (run.isPending) return <Loading />;
  if (!run.data) return <ErrorStrip error={run.error} />;
  const r = run.data;
  const busy = r.status === "queued" || r.status === "running";

  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { label: "Pipelines", to: `/tenants/${r.tenantId}/pipelines` },
          { label: r.pipelineName, to: `/pipelines/${r.pipelineId}/scenarios` },
          { label: r.scenarioName, to: `/scenarios/${r.scenarioId}` },
        ]}
        title={`Run of ${formatDateTime(r.requestedAt)}`}
        subtitle={
          <span className="facts">
            <RunStatusTag status={r.status} />
            {r.total !== null && (
              <span>
                {r.passed} of {counted(r.total, "check")} passed
              </span>
            )}
            {r.requestedBy && <span>Asked for by {r.requestedBy}</span>}
          </span>
        }
      />
      {r.error && (
        <MessageStrip design="Negative" hideCloseButton className="block">
          {r.error}
        </MessageStrip>
      )}
      {busy && <p className="muted">The worker is sending the checks as SELECTs that read only the scenario&apos;s rows. This page refreshes on its own.</p>}
      {r.checks && (
        <section className="block">
          <Title level="H4">Checks</Title>
          <Table
            overflowMode="Popin"
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell minWidth={monoColumnWidth(r.checks.map((c) => c.checkpoint))} importance={1}>
                  Step
                </TableHeaderCell>
                <TableHeaderCell minWidth="12rem" importance={1}>
                  Check
                </TableHeaderCell>
                <TableHeaderCell minWidth="6rem">Result</TableHeaderCell>
                <TableHeaderCell minWidth="14rem">What came back</TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {r.checks.map((c, i) => (
              <TableRow key={i} rowKey={String(i)}>
                <TableCell>
                  <span className="mono">{c.checkpoint.split(".").pop()}</span>
                </TableCell>
                <TableCell>
                  <span className="mono">{c.label}</span>
                </TableCell>
                <TableCell>
                  <Tag design={CHECK_STATUS[c.status].design}>{CHECK_STATUS[c.status].label}</Tag>
                </TableCell>
                <TableCell>
                  <span className="wrap-anywhere">{c.detail}</span>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </section>
      )}
      {r.steps && (
        <section className="block">
          <Title level="H4">How each step was simulated</Title>
          <StepsTable steps={r.steps} />
        </section>
      )}
    </div>
  );
}
