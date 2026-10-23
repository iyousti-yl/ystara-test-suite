import { useMemo, useState } from "react";
import { SegmentedButton, SegmentedButtonItem } from "@ui5/webcomponents-react";
import { matchesPattern, refKey, type PipelineResult } from "@ystara/shared";
import { counted } from "../format";
import { typeLabel } from "../objectTypes";
import { useDarkMode } from "../theme";
import { LineageGraph } from "./LineageGraph";
import { exclusionFor, lineageModel } from "./model";
import { ObjectPanel } from "./ObjectPanel";
import { PipelineChecks } from "./PipelineChecks";

/**
 * A pipeline: what to check in it (several writers, loops) in one quiet line,
 * the lineage picture with the selected object's details beside it, and the
 * steps in order. Used for a pipeline being tried on a scan and for a saved one.
 */
export function PipelineView(props: {
  result: PipelineResult;
  /** Given when exclusions can be changed here: on a scan, or on a saved pipeline by someone who may change it. */
  onExclusionsChange?: (excludeWriters: string[]) => void;
  /** While a change of exclusions is being saved. */
  busy?: boolean;
  onShowPipeline?: (output: string) => void;
}) {
  const { result, onExclusionsChange, onShowPipeline, busy } = props;
  const { pipeline } = result;
  const model = useMemo(() => lineageModel(pipeline, result.graph, result.measurement), [pipeline, result.graph, result.measurement]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"lineage" | "steps">("lineage");
  const dark = useDarkMode();

  // After an exclusion the selection stays if the object is still drawn, and is simply gone if it isn't.
  const node = model.nodes.find((n) => n.key === selected);

  const exclude = (...patterns: string[]) => onExclusionsChange?.([...new Set([...result.excludeWriters, ...patterns])]);
  const measurable = Object.values(result.measurement).filter((m) => m.measurable).length;
  const follow = (writerKey: string) =>
    onExclusionsChange?.(
      result.excludeWriters.filter((p) => !pipeline.excludedWriters.some((x) => refKey(x.writer) === writerKey && matchesPattern(p, x.writer))),
    );

  return (
    <div className="pipeline">
      <PipelineChecks
        pipeline={pipeline}
        busy={busy}
        onIgnore={onExclusionsChange && ((writers) => exclude(...writers.map((w) => exclusionFor(w, pipeline))))}
      />

      <div className="pipeline-bar">
        <SegmentedButton onSelectionChange={(e) => setView(e.detail.selectedItems[0]?.dataset.view === "steps" ? "steps" : "lineage")}>
          <SegmentedButtonItem data-view="lineage" selected={view === "lineage"}>
            Picture
          </SegmentedButtonItem>
          <SegmentedButtonItem data-view="steps" selected={view === "steps"}>
            Steps in order ({pipeline.steps.length})
          </SegmentedButtonItem>
        </SegmentedButton>
        <span className="muted">
          {counted(pipeline.entryPoints.length, "input table")} · {measurable} measurable by snapshots
        </span>
      </div>

      {view === "lineage" ? (
        <div className="pipeline-main">
          <div className="pipeline-graph">
            <LineageGraph nodes={model.nodes} edges={model.edges} selected={node?.key} onSelect={setSelected} dark={dark} />
          </div>
          {node && (
            <ObjectPanel
              key={node.key}
              scanId={result.scanId}
              node={node}
              within={refKey(pipeline.output)}
              onExclude={onExclusionsChange && (() => exclude(exclusionFor(node.ref, pipeline)))}
              onFollow={onExclusionsChange && (() => follow(node.key))}
              onShowPipeline={onShowPipeline && (() => onShowPipeline(node.key))}
            />
          )}
        </div>
      ) : (
        <section className="steps-view">
          <p className="muted">Upstream first, the output last: each step comes after everything it depends on.</p>
          <ol className="steps">
            {pipeline.steps.map((s) => (
              <li key={refKey(s)}>
                <span className="mono">{s.technicalName}</span> <span className="muted">{typeLabel(s.type)}</span>
                {result.measurement[refKey(s)]?.measurable && <span className="flag flag-measurable steps-flag">Measurable</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
