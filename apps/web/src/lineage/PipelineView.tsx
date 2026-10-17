import { useMemo, useState } from "react";
import { MessageStrip, SegmentedButton, SegmentedButtonItem } from "@ui5/webcomponents-react";
import { matchesPattern, refKey, type PipelineResult } from "@ystara/shared";
import { typeLabel } from "../objectTypes";
import { useDarkMode } from "../theme";
import { LineageGraph } from "./LineageGraph";
import { exclusionFor, lineageModel } from "./model";
import { ObjectPanel } from "./ObjectPanel";

/**
 * A pipeline: what needs attention (several writers, loops), the lineage
 * picture with the selected object's details beside it, and the steps in order.
 * Used for a pipeline being tried on a scan and for a saved one.
 */
export function PipelineView(props: {
  result: PipelineResult;
  /** Given when exclusions can be changed here. */
  onExclusionsChange?: (excludeWriters: string[]) => void;
  onShowPipeline?: (output: string) => void;
}) {
  const { result, onExclusionsChange, onShowPipeline } = props;
  const { pipeline } = result;
  const model = useMemo(() => lineageModel(pipeline, result.graph, result.measurement), [pipeline, result.graph, result.measurement]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"lineage" | "steps">("lineage");
  const dark = useDarkMode();

  // After an exclusion the selection stays if the object is still drawn, and is simply gone if it isn't.
  const node = model.nodes.find((n) => n.key === selected);

  const exclude = (pattern: string) => onExclusionsChange?.([...result.excludeWriters, pattern]);
  const follow = (writerKey: string) =>
    onExclusionsChange?.(
      result.excludeWriters.filter((p) => !pipeline.excludedWriters.some((x) => refKey(x.writer) === writerKey && matchesPattern(p, x.writer))),
    );

  return (
    <div className="pipeline">
      {pipeline.ambiguousWriters.map((a) => (
        <MessageStrip key={refKey(a.table)} design="Critical" hideCloseButton>
          <span className="mono">{a.table.technicalName}</span> has several writers:{" "}
          <span className="mono">{a.writers.map((w) => w.technicalName).join(", ")}</span>. All of them were followed, so this pipeline may include
          another process.{" "}
          {onExclusionsChange ? "Select the writer that doesn't belong in the picture and exclude it." : "Exclude the one that doesn't belong when you try this pipeline on a scan."}
        </MessageStrip>
      ))}
      {pipeline.cycles.map((c) => (
        <MessageStrip key={c.map(refKey).join()} design="Negative" hideCloseButton>
          Loop: <span className="mono">{c.map((r) => r.technicalName).join(" → ")}</span>. The order of these steps can't be determined.
        </MessageStrip>
      ))}

      <SegmentedButton onSelectionChange={(e) => setView(e.detail.selectedItems[0]?.dataset.view === "steps" ? "steps" : "lineage")}>
        <SegmentedButtonItem data-view="lineage" selected={view === "lineage"}>
          Lineage
        </SegmentedButtonItem>
        <SegmentedButtonItem data-view="steps" selected={view === "steps"}>
          Steps in order ({pipeline.steps.length})
        </SegmentedButtonItem>
      </SegmentedButton>

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
