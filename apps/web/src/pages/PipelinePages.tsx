import { useState } from "react";
import { Button, Dialog, Input, Label, Token, Tokenizer } from "@ui5/webcomponents-react";
import type { PipelineResult } from "@ystara/shared";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { pipelineQuery, useCan, useDeletePipeline, usePipelineOnScan, useSavedPipeline, useSavePipeline, useScan, useTakeSnapshot, useTenant } from "../api";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { PipelineView } from "../lineage/PipelineView";
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
  const tenant = useTenant(scan.data?.tenantId ?? "");
  const result = usePipelineOnScan(scanId, output, excludeWriters);
  const [saving, setSaving] = useState(false);

  const setExclusions = (patterns: string[]) => setParams(pipelineQuery(output, [...new Set(patterns)]), { replace: true });
  const outputName = output.split(".").pop() ?? output;

  return (
    <div className="page page-wide">
      <PageHeader
        crumbs={[
          { label: "Tenants", to: "/" },
          { label: tenant.data?.name ?? "Tenant", to: `/tenants/${scan.data?.tenantId ?? ""}` },
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
          suggestedName={outputName}
          onClose={() => setSaving(false)}
          onSaved={(id) => navigate(`/pipelines/${id}`)}
        />
      )}
    </div>
  );
}

/** A saved pipeline, computed on the tenant's latest successful scan, and its snapshots. */
export function SavedPipelinePage() {
  const { pipelineId = "" } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const result = useSavedPipeline(pipelineId);
  const remove = useDeletePipeline();
  const takeSnapshot = useTakeSnapshot(pipelineId);
  const definition = result.data?.definition;
  const tenant = useTenant(definition?.tenantId ?? "");

  if (result.isPending) return <Loading />;
  if (!result.data || !definition) return <ErrorStrip error={result.error} />;
  const output = `${definition.output.space}.${definition.output.technicalName}`;
  const measurable = Object.values(result.data.measurement).some((m) => m.measurable);

  return (
    <div className="page page-wide">
      <PageHeader
        crumbs={[
          { label: "Tenants", to: "/" },
          { label: tenant.data?.name ?? "Tenant", to: `/tenants/${definition.tenantId}` },
        ]}
        title={definition.name}
        subtitle={
          <span className="facts">
            <span className="mono">{output}</span>
            <span>Computed on the latest successful scan</span>
            <Summary result={result.data} />
          </span>
        }
        actions={
          <>
            {can("runs.execute") && (
              <Button
                design="Emphasized"
                icon="camera"
                disabled={!measurable || takeSnapshot.isPending}
                tooltip={measurable ? "Measure the steps the database users can see" : "No step can be measured with SQL yet: select a step to see why"}
                onClick={() => takeSnapshot.mutate()}
              >
                Take snapshot
              </Button>
            )}
            <Button
              icon="chain-link"
              onClick={() => navigate(`/scans/${result.data.scanId}/pipeline?${pipelineQuery(output, definition.excludeWriters)}`)}
            >
              Change exclusions
            </Button>
            {can("pipelines.write") && (
              <Button
                design="Transparent"
                icon="delete"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Delete the saved pipeline "${definition.name}"? Nothing changes in Datasphere.`)) {
                    remove.mutate(definition, { onSuccess: () => navigate(`/tenants/${definition.tenantId}`) });
                  }
                }}
              >
                Delete
              </Button>
            )}
          </>
        }
      />
      <Exclusions patterns={definition.excludeWriters} />
      <ErrorStrip error={remove.error ?? takeSnapshot.error} />
      <PipelineView result={result.data} />
      <SnapshotsSection pipelineId={definition.id} />
    </div>
  );
}

function Summary({ result }: { result: PipelineResult | undefined }) {
  if (!result) return null;
  const { pipeline } = result;
  const measurable = Object.values(result.measurement).filter((m) => m.measurable).length;
  return (
    <span>
      {pipeline.steps.length} steps, {pipeline.entryPoints.length} entry {pipeline.entryPoints.length === 1 ? "table" : "tables"}, {measurable} measurable by
      snapshots
    </span>
  );
}

/** Writers left out because they belong to other processes. Removable while trying a pipeline. */
function Exclusions({ patterns, onRemove }: { patterns: string[]; onRemove?: (pattern: string) => void }) {
  if (patterns.length === 0) return null;
  return (
    <div className="exclusions">
      <Label>Excluded writers</Label>
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
  const save = useSavePipeline(props.tenantId);
  const [name, setName] = useState(props.suggestedName);
  const submit = () =>
    save.mutate({ name: name.trim(), output: props.output, excludeWriters: props.excludeWriters }, { onSuccess: (p) => props.onSaved(p.id) });

  return (
    <Dialog
      open
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
        <Input id="pipeline-name" value={name} onInput={(e) => setName(e.target.value)} />
        <p className="muted">
          Saves the output <span className="mono">{props.output}</span>
          {props.excludeWriters.length > 0 && <> and the excluded writers</>}. The steps are worked out again from each new scan, so the pipeline
          follows the tenant as it changes.
        </p>
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
