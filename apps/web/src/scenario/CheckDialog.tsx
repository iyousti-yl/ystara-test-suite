import { useState } from "react";
import {
  Button,
  ComboBox,
  ComboBoxItem,
  Dialog,
  Input,
  Label,
  MultiComboBox,
  MultiComboBoxItem,
  Option,
  Select,
  StepInput,
  TextArea,
} from "@ui5/webcomponents-react";
import type { Assertion, ScenarioColumn } from "@ystara/shared";
import { ASSERTION_KINDS, cellFromText, gridFromRows, rowsFromGrid, textFromCell, type Grid } from "./model";
import { RowsGrid } from "./RowsGrid";

/** A step a check can be on, with its columns when its definition lists them. */
export interface Checkpoint {
  key: string;
  technicalName: string;
  type: string;
  columns: ScenarioColumn[] | null;
}

const AGGREGATE_FNS = ["sum", "min", "max", "avg", "count_distinct"] as const;

/** The dialog's fields, as text, for every kind of check at once: switching kinds keeps what was typed. */
interface Form {
  checkpoint: string;
  type: Assertion["type"];
  count: number;
  columns: string[];
  column: string;
  fn: (typeof AGGREGATE_FNS)[number];
  equals: string;
  tolerance: string;
  key: string[];
  /** Columns of the expected rows, typed in when the step's definition doesn't list them. */
  rowColumns: string;
  grid: Grid;
  query: string;
}

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function formOf(checkpoint: Checkpoint, a: Assertion | undefined): Form {
  const columns = checkpoint.columns ?? [];
  const form: Form = {
    checkpoint: checkpoint.key,
    type: a?.type ?? "row_count",
    count: 0,
    columns: [],
    column: "",
    fn: "sum",
    equals: "",
    tolerance: "",
    key: [],
    rowColumns: "",
    grid: { columns, rows: [] },
    query: "SELECT COUNT(*) FROM {{checkpoint}} AS c WHERE ",
  };
  switch (a?.type) {
    case "row_count":
      return { ...form, count: a.equals };
    case "no_nulls":
    case "unique":
      return { ...form, columns: a.columns };
    case "aggregate":
      return { ...form, column: a.column, fn: a.fn, equals: String(a.equals), tolerance: a.tolerance ? String(a.tolerance) : "" };
    case "rows_equal": {
      const grid = gridFromRows(columns, a.rows);
      return { ...form, key: a.key, grid, rowColumns: checkpoint.columns ? "" : grid.columns.map((c) => c.name).join(", ") };
    }
    case "sql":
      return { ...form, query: a.query, equals: textFromCell(a.equals) };
    default:
      return form;
  }
}

/** A number typed with a comma or a point, or undefined. */
const numberOf = (text: string) => {
  const { cell, invalid } = cellFromText(text, "DOUBLE");
  return cell === undefined || invalid ? undefined : Number(cell);
};

/** The check the form describes, or what is still missing. */
function assertionOf(f: Form): { assertion: Assertion } | { missing: string } {
  switch (f.type) {
    case "row_count":
      return { assertion: { type: "row_count", equals: f.count } };
    case "no_nulls":
    case "unique":
      return f.columns.length ? { assertion: { type: f.type, columns: f.columns } } : { missing: "Pick at least one column." };
    case "aggregate": {
      const equals = numberOf(f.equals);
      const tolerance = f.tolerance.trim() ? numberOf(f.tolerance) : 0;
      if (!f.column.trim()) return { missing: "Pick a column." };
      if (equals === undefined) return { missing: "Type the value it equals, as a number." };
      if (tolerance === undefined || tolerance < 0) return { missing: "The tolerance is a number of 0 or more." };
      return { assertion: { type: "aggregate", column: f.column.trim(), fn: f.fn, equals, tolerance } };
    }
    case "rows_equal":
      if (!f.key.length) return { missing: "Pick the key columns that match a row with its expected row." };
      return { assertion: { type: "rows_equal", key: f.key, rows: rowsFromGrid(f.grid) } };
    case "sql": {
      if (!/\{\{checkpoint\}\}/.test(f.query)) return { missing: "The query reads the step's result as {{checkpoint}}." };
      if (!f.equals.trim()) return { missing: "Type the value it returns." };
      const n = numberOf(f.equals);
      return { assertion: { type: "sql", query: f.query.trim(), equals: n ?? f.equals } };
    }
  }
}

/**
 * Adding or changing one check: the step it is on, what kind of check, and
 * that kind's fields. Column pickers offer the step's columns; when its
 * definition doesn't list them, column names are typed in.
 */
export function CheckDialog(props: {
  checkpoints: Checkpoint[];
  initial: { checkpoint: string; assertion?: Assertion };
  onSave: (checkpoint: string, assertion: Assertion) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(() => formOf(props.checkpoints.find((c) => c.key === props.initial.checkpoint) ?? props.checkpoints[0], props.initial.assertion));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const checkpoint = props.checkpoints.find((c) => c.key === form.checkpoint) ?? props.checkpoints[0];
  const known = checkpoint.columns;
  const result = assertionOf(form);
  const kind = ASSERTION_KINDS.find((k) => k.type === form.type)!;

  /** The grid's columns: the step's, or those typed in. */
  const rowGrid: Grid = known ? form.grid : { ...form.grid, columns: list(form.rowColumns).map((name) => ({ name, type: "" })) };

  return (
    <Dialog
      open
      className="check-dialog"
      headerText={props.initial.assertion ? "Change check" : "Add check"}
      onClose={props.onClose}
      footer={
        <div className="dialog-footer">
          {"missing" in result && <span className="muted">{result.missing}</span>}
          <Button design="Emphasized" disabled={"missing" in result} onClick={() => "assertion" in result && props.onSave(form.checkpoint, result.assertion)}>
            {props.initial.assertion ? "Apply" : "Add"}
          </Button>
          <Button design="Transparent" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body check-dialog-body">
        <Label for="check-step" required>
          Step
        </Label>
        <Select
          id="check-step"
          onChange={(e) => {
            const next = props.checkpoints.find((c) => c.key === e.detail.selectedOption.value);
            if (next) set({ checkpoint: next.key, grid: { columns: next.columns ?? [], rows: form.grid.rows } });
          }}
        >
          {props.checkpoints.map((c) => (
            <Option key={c.key} value={c.key} selected={c.key === form.checkpoint}>
              {c.technicalName} ({c.type})
            </Option>
          ))}
        </Select>

        <Label for="check-kind" required>
          Check
        </Label>
        <Select id="check-kind" onChange={(e) => set({ type: e.detail.selectedOption.value as Assertion["type"] })}>
          {ASSERTION_KINDS.map((k) => (
            <Option key={k.type} value={k.type} selected={k.type === form.type}>
              {k.label}
            </Option>
          ))}
        </Select>
        <p className="muted">{kind.help}</p>

        {form.type === "row_count" && (
          <>
            <Label for="check-count" required>
              Rows
            </Label>
            <StepInput id="check-count" min={0} value={form.count} onChange={(e) => set({ count: Math.max(0, Math.round(e.target.value)) })} />
          </>
        )}

        {(form.type === "no_nulls" || form.type === "unique") && (
          <ColumnsField id="check-columns" label="Columns" columns={known} value={form.columns} onChange={(columns) => set({ columns })} />
        )}

        {form.type === "aggregate" && (
          <>
            <Label for="check-fn" required>
              Of
            </Label>
            <Select id="check-fn" onChange={(e) => set({ fn: e.detail.selectedOption.value as Form["fn"] })}>
              {AGGREGATE_FNS.map((fn) => (
                <Option key={fn} value={fn} selected={fn === form.fn}>
                  {fn === "count_distinct" ? "distinct values (count)" : fn === "avg" ? "average" : fn}
                </Option>
              ))}
            </Select>
            <Label for="check-column" required>
              Column
            </Label>
            <ComboBox id="check-column" value={form.column} onInput={(e) => set({ column: e.target.value })} onChange={(e) => set({ column: e.target.value })}>
              {(known ?? []).map((c) => (
                <ComboBoxItem key={c.name} text={c.name} additionalText={c.type} />
              ))}
            </ComboBox>
            <Label for="check-equals" required>
              Equals
            </Label>
            <Input id="check-equals" value={form.equals} inputMode="decimal" onInput={(e) => set({ equals: e.target.value })} />
            <Label for="check-tolerance">Tolerance (±)</Label>
            <Input id="check-tolerance" value={form.tolerance} placeholder="0" inputMode="decimal" onInput={(e) => set({ tolerance: e.target.value })} />
          </>
        )}

        {form.type === "rows_equal" && (
          <>
            {!known && (
              <>
                <Label for="check-row-columns" required>
                  Columns of the expected rows
                </Label>
                <Input id="check-row-columns" value={form.rowColumns} placeholder="ID, AMOUNT" onInput={(e) => set({ rowColumns: e.target.value })} />
              </>
            )}
            <ColumnsField
              id="check-key"
              label="Key columns"
              columns={known ?? rowGrid.columns}
              value={form.key}
              onChange={(key) => set({ key })}
            />
            <p className="muted">
              The step must have these rows and no others. Rows are matched on the key columns, then every column a row gives is compared; a column left empty
              isn&apos;t compared.
            </p>
            <RowsGrid label="Expected rows" grid={rowGrid} onChange={(grid) => set({ grid })} />
          </>
        )}

        {form.type === "sql" && (
          <>
            <Label for="check-query" required>
              Query
            </Label>
            <TextArea id="check-query" className="mono" rows={4} growing value={form.query} onInput={(e) => set({ query: e.target.value })} />
            <p className="muted">
              One SELECT that returns one value. <span className="mono">{"{{checkpoint}}"}</span> stands for the step&apos;s result.
            </p>
            <Label for="check-sql-equals" required>
              Returns
            </Label>
            <Input id="check-sql-equals" value={form.equals} onInput={(e) => set({ equals: e.target.value })} />
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Columns picked from the step's, or typed in, apart by commas, when its definition doesn't list them. */
function ColumnsField(props: { id: string; label: string; columns: ScenarioColumn[] | null; value: string[]; onChange: (columns: string[]) => void }) {
  const [text, setText] = useState(props.value.join(", "));
  return (
    <>
      <Label for={props.id} required>
        {props.label}
      </Label>
      {props.columns && props.columns.length > 0 ? (
        <MultiComboBox id={props.id} onSelectionChange={(e) => props.onChange(e.detail.items.map((item) => item.text ?? "").filter(Boolean))}>
          {props.columns.map((c) => (
            <MultiComboBoxItem key={c.name} text={c.name} additionalText={c.type || undefined} selected={props.value.includes(c.name)} />
          ))}
        </MultiComboBox>
      ) : (
        <Input
          id={props.id}
          value={text}
          placeholder="ID, AMOUNT"
          onInput={(e) => {
            setText(e.target.value);
            props.onChange(list(e.target.value));
          }}
        />
      )}
    </>
  );
}
