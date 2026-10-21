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
import {
  parseScenarioYaml,
  refKey,
  scenarioProblems,
  toScenarioYaml,
  whyNoScenarioRun,
  type Assertion,
  type Expectation,
  type Fixture,
  type ObjectType,
  type ScenarioInputs,
  type ScenarioSpec,
  type ScenarioStepNote,
} from "@ystara/shared";
import { useBeforeUnload, useBlocker, useNavigate, useParams } from "react-router";
import {
  useCan,
  useDatabaseUsers,
  useDeleteScenario,
  useDraftScenario,
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
import { readWorkbook, workbookOf } from "../scenario/excel";
import { assertionLabel, cellFromText, gridFromRows, rowsFromGrid, shownColumns, type Grid } from "../scenario/model";
import { RowsGrid } from "../scenario/RowsGrid";
import { useInTenant } from "../tenantScope";

/**
 * Scenarios (phase 3b): a saved pipeline's test cases, built in the app. A
 * scenario gives test rows for the pipeline's tables and the checks expected
 * at its steps; the builder compiles it as it changes (nothing is sent to the
 * tenant), and a run sends each check as one SELECT that reads only those rows.
 * The same scenario can be read as a scenario file (YAML) for Git or the CLI,
 * and loaded from one. Test rows can go out to Excel and come back (excel.ts),
 * and Claude can draft the rows and checks from the description (phase 3c).
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
      <p className="muted section-intro">
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
            <TableHeaderCell minWidth="5rem">Checks</TableHeaderCell>
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
            <TableCell>{checkCount(s.spec)}</TableCell>
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

/** A scenario as the builder starts from it: saved, loaded from a file, drafted by Claude, or none for a new one. */
type StartSpec = Omit<ScenarioSpec, "pipeline" | "version" | "tags"> & { tags?: string[] };

/** What the builder edits, from a scenario (or a new one) and what the pipeline offers. */
function startingPoint(inputs: ScenarioInputs, spec: StartSpec | undefined) {
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
function draftOf(s: Start): ScenarioDraft {
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
  const start = useMemo(() => startingPoint(inputs, saved?.spec), [inputs, saved]);
  const [name, setName] = useState(start.name);
  const [kind, setKind] = useState(start.kind);
  const [description, setDescription] = useState(start.description);
  const [grids, setGrids] = useState(start.grids);
  const [expect, setExpect] = useState(start.expect);
  // The tables with rows, CSV fixtures and tags: they change only when a file or a draft is loaded.
  const [shape, setShape] = useState({ tables: start.tables, kept: start.kept, tags: start.tags });
  const [editing, setEditing] = useState<{ expectation: number; assertion: number } | { checkpoint: string } | undefined>();
  // Tables whose grid shows every column, not only the keys and those the pipeline reads.
  const [allColumns, setAllColumns] = useState<Record<string, boolean>>({});
  const [drafted, setDrafted] = useState<{ notes: string[]; problems: string[] }>();
  const [rowsNote, setRowsNote] = useState<Note>();
  const [fileNote, setFileNote] = useState<Note>();
  const rowsFile = useRef<HTMLInputElement>(null);
  const scenarioFile = useRef<HTMLInputElement>(null);
  const drafting = useDraftScenario(pipelineId);
  const save = useSaveScenario(pipelineId, saved?.id);
  const remove = useDeleteScenario(pipelineId);
  const run = useRunScenario(pipelineId, saved?.id ?? "");
  const tenant = useTenant(props.tenantId);
  const databaseUsers = useDatabaseUsers(props.tenantId);
  // Why no scenario of this tenant can run (an imported tenant, no connected database user), once both are known.
  const whyNoRun = tenant.data && databaseUsers.data ? whyNoScenarioRun(databaseUsers.data, tenant.data.host !== null) : undefined;

  const draft = useMemo(() => draftOf({ ...shape, name, kind, description, grids, expect }), [shape, name, kind, description, grids, expect]);
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

  const hasRowsOrChecks = expect.length > 0 || Object.values(grids).some((g) => g.rows.length > 0);

  /** Everything the builder edits, from another scenario: a file or Claude's draft. Saving keeps it. */
  const load = (spec: StartSpec) => {
    const next = startingPoint(inputs, spec);
    setName(next.name);
    setKind(next.kind);
    setDescription(next.description);
    setGrids(next.grids);
    setExpect(next.expect);
    setShape({ tables: next.tables, kept: next.kept, tags: next.tags });
    setEditing(undefined);
    // What an earlier upload or draft said is about rows that are gone now.
    setRowsNote(undefined);
    setDrafted(undefined);
    setFileNote(undefined);
  };

  const draftWithClaude = () => {
    if (hasRowsOrChecks && !window.confirm("Replace the test rows and checks with Claude's draft?")) return;
    setDrafted(undefined);
    drafting.mutate(
      { description: description.trim(), ...(name.trim() ? { name: name.trim() } : {}), kind },
      {
        onSuccess: (d) => {
          load({ ...d.scenario, tags: shape.tags });
          setDrafted({ notes: d.notes, problems: d.problems });
        },
      },
    );
  };

  const downloadRows = async () => {
    try {
      const tables = shape.tables.map((t) => ({ key: t.key, technicalName: t.technicalName, grid: grids[t.key], shown: shownColumns(grids[t.key], allColumns[t.key]) }));
      saveFile(await workbookOf(tables), `${props.pipelineName} test rows.xlsx`);
    } catch (e) {
      setRowsNote({ design: "Negative", title: "The Excel file couldn't be made.", lines: [e instanceof Error ? e.message : String(e)] });
    }
  };

  const uploadRows = async (file: File) => {
    setRowsNote(undefined);
    try {
      const read = await readWorkbook(
        file,
        shape.tables.map((t) => ({ key: t.key, technicalName: t.technicalName, columns: grids[t.key].columns })),
      );
      if (!read.rows.size) {
        setRowsNote({ design: "Negative", title: `${file.name} has no sheet for a table of this pipeline.`, lines: read.problems });
        return;
      }
      const replaced = [...read.rows.keys()].filter((key) => grids[key].rows.length > 0);
      if (replaced.length && !window.confirm(`Replace the rows of ${replaced.map((key) => key.split(".").pop()).join(", ")} with those in ${file.name}?`)) return;
      setGrids((all) => ({ ...all, ...Object.fromEntries([...read.rows].map(([key, rows]) => [key, { ...all[key], rows }])) }));
      const total = [...read.rows.values()].reduce((n, rows) => n + rows.length, 0);
      setRowsNote({
        design: read.problems.length ? "Critical" : "Positive",
        title: `Read ${counted(total, "row")} for ${counted(read.rows.size, "table")} from ${file.name}. Save to keep them.`,
        lines: read.problems,
      });
    } catch (e) {
      setRowsNote({ design: "Negative", title: `${file.name} couldn't be read as an Excel workbook (.xlsx).`, lines: [e instanceof Error ? e.message : String(e)] });
    }
  };

  const loadScenarioFile = async (file: File) => {
    setFileNote(undefined);
    let spec: ScenarioSpec;
    try {
      spec = parseScenarioYaml(await file.text());
    } catch (e) {
      setFileNote({ design: "Negative", title: `${file.name} isn't a scenario file the builder can read.`, lines: scenarioProblems(e) });
      return;
    }
    if (hasRowsOrChecks && !window.confirm(`Replace this scenario's name, rows and checks with those in ${file.name}?`)) return;
    load(spec);
    const elsewhere = spec.pipeline !== props.output && spec.pipeline !== props.output.split(".").pop();
    setFileNote(
      elsewhere
        ? { design: "Critical", title: `Loaded ${file.name}. It was written for ${spec.pipeline}: its rows and checks now count for ${props.output}. Save to keep them.`, lines: [] }
        : { design: "Positive", title: `Loaded ${file.name}. Save to keep it.`, lines: [] },
    );
  };

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
      {saved && whyNoRun && can("runs.execute") && (
        <MessageStrip design="Information" hideCloseButton>
          {whyNoRun}
        </MessageStrip>
      )}

      <section className="block scenario-about">
        <div className="scenario-field">
          <Label for="scenario-name" required>
            Name
          </Label>
          <Input id="scenario-name" value={name} readonly={!editable} placeholder="What this scenario shows, in a few words" onInput={(e) => setName(e.target.value)} />
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
            placeholder={
              inputs.drafting
                ? "The case in a sentence or two: which rows go in and what should come out. Claude can draft the rows and checks from it."
                : "The case in a sentence or two: which rows go in and what should come out"
            }
            onInput={(e) => setDescription(e.target.value)}
          />
        </div>
        {editable && (
          <div className="scenario-field-wide scenario-draft">
            <Button
              icon="ai"
              disabled={!inputs.drafting || !description.trim() || drafting.isPending}
              tooltip={!inputs.drafting ? undefined : !description.trim() ? "Describe the scenario first" : "Claude drafts test rows and checks from the description and the pipeline's logic"}
              onClick={draftWithClaude}
            >
              {drafting.isPending ? "Drafting…" : "Draft rows and checks with Claude"}
            </Button>
            <span className="muted">
              {drafting.isPending
                ? "Claude is reading the pipeline's logic and working out what each step should give. This can take a minute or two."
                : inputs.drafting
                  ? "Sends the description and the pipeline's definitions (names, columns and logic) to Claude, never the tenant's data."
                  : "Drafting with Claude isn't set up yet: Ystara's operator enters an Anthropic API key on the operator panel."}
            </span>
          </div>
        )}
        {drafting.error && (
          <div className="scenario-field-wide">
            <ErrorStrip error={drafting.error} />
          </div>
        )}
        {drafted && (
          <div className="scenario-field-wide">
            <NoteStrip
              note={{
                design: drafted.problems.length ? "Critical" : "Information",
                title: drafted.problems.length
                  ? `Claude's draft still has problems: ${drafted.problems.join(" ")} Fix them below, or describe the case differently and draft again.`
                  : "Claude drafted the rows and checks below. Check them before you save: Claude works the expected values out from the logic, and can be wrong.",
                lines: drafted.notes,
              }}
              onClose={() => setDrafted(undefined)}
            />
          </div>
        )}
      </section>

      <section className="block">
        <div className="list-toolbar section-toolbar">
          <Title level="H4">Test rows</Title>
          {shape.tables.length > 0 && (
            <Button icon="excel-attachment" tooltip="One sheet per table, with the columns the grids show and the rows they have" onClick={() => void downloadRows()}>
              Download Excel template
            </Button>
          )}
          {editable && shape.tables.length > 0 && (
            <>
              <Button icon="upload" tooltip="The template filled in: each sheet's rows replace its table's" onClick={() => rowsFile.current?.click()}>
                Upload Excel file
              </Button>
              <input
                ref={rowsFile}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadRows(file);
                }}
              />
            </>
          )}
        </div>
        {rowsNote && <NoteStrip note={rowsNote} onClose={() => setRowsNote(undefined)} />}
        <p className="muted page-intro">
          These rows stand in for the pipeline&apos;s tables. A table you give no rows is empty in this scenario. Use made-up values, not rows copied from the
          tenant: the scenario is stored in Ystara.
        </p>
        {shape.tables.length === 0 && (
          <MessageStrip design="Critical" hideCloseButton>
            No table of this pipeline takes rows: every one is loaded by a step that can&apos;t be compiled. The steps below say why.
          </MessageStrip>
        )}
        {shape.tables.map((t) => (
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
              <RowsGrid
                label={`Rows of ${t.technicalName}`}
                grid={grids[t.key]}
                readOnly={!editable}
                onChange={(g) => setGrids((all) => ({ ...all, [t.key]: g }))}
                allColumns={allColumns[t.key] ?? false}
                onAllColumns={(all) => setAllColumns((current) => ({ ...current, [t.key]: all }))}
              />
            )}
          </div>
        ))}
        {shape.kept.map((f) => (
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
        <div className="list-toolbar">
          <Button icon="copy" onClick={() => void navigator.clipboard.writeText(toScenarioYaml(spec))}>
            Copy
          </Button>
          {editable && (
            <>
              <Button icon="document-text" tooltip="A scenario file's name, rows and checks replace this scenario's" onClick={() => scenarioFile.current?.click()}>
                Load a scenario file
              </Button>
              <input
                ref={scenarioFile}
                type="file"
                accept=".yaml,.yml"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void loadScenarioFile(file);
                }}
              />
            </>
          )}
        </div>
        {fileNote && <NoteStrip note={fileNote} onClose={() => setFileNote(undefined)} />}
        <pre className="cli-output scenario-yaml">{toScenarioYaml(spec)}</pre>
      </Panel>

      {saved && <RunsSection scenarioId={saved.id} />}

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

/** What came of loading a file or drafting: a line, and the details below it. */
interface Note {
  design: "Positive" | "Information" | "Critical" | "Negative";
  title: string;
  lines: string[];
}

function NoteStrip({ note, onClose }: { note: Note; onClose: () => void }) {
  return (
    <div className="scenario-note">
      <MessageStrip design={note.design} onClose={onClose}>
        {note.title}
      </MessageStrip>
      {note.lines.length > 0 && (
        <ul className="scenario-note-lines">
          {note.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Hands the browser a file to save, as a download. */
function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

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
            <span className="wrap-anywhere">
              {s.note}
              {s.problem && <span className="text-negative">: {s.problem}</span>}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

function RunsSection({ scenarioId }: { scenarioId: string }) {
  const navigate = useNavigate();
  const runs = useScenarioRuns(scenarioId);
  const time = formatDateTimesApart((runs.data ?? []).map((r) => r.requestedAt));
  return (
    <section className="block">
      <Title level="H4">{runs.data ? counted(runs.data.length, "run") : "Runs"}</Title>
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
