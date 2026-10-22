import { Button, MessageStrip, Panel, Tag, Text, Title } from "@ui5/webcomponents-react";
import { refKey, type DspObjectRef } from "@ystara/shared";
import { useObject } from "../api";
import { typeColor, typeLabel } from "../objectTypes";
import { whyNotMeasurable, type LineageNode } from "./model";

/**
 * Details of the selected object: what it reads and writes, which facts the
 * picture marks on it and why (including whether a snapshot can measure it),
 * its definition as the CLI returned it, and the actions that apply to it.
 */
export function ObjectPanel(props: {
  scanId: string;
  node: LineageNode;
  /** The pipeline's output (SPACE.NAME): its steps open whatever spaces the member is limited to. */
  within: string;
  /** Present when exclusions can be changed here (trying a pipeline, not a saved one). */
  onExclude?: () => void;
  onFollow?: () => void;
  onShowPipeline?: () => void;
}) {
  const { scanId, node, within, onExclude, onFollow, onShowPipeline } = props;
  const { ref } = node;
  const details = useObject(scanId, ref, within);
  const edges = details.data?.edges ?? [];
  const key = refKey(ref);

  return (
    <aside className="object-panel" aria-label={`Details of ${ref.technicalName}`}>
      <div className="caption">
        <span className="type-dot" style={{ background: typeColor(ref.type) }} />
        {typeLabel(ref.type)} · {ref.space}
      </div>
      <Title level="H2" size="H5" wrappingType="Normal" className="object-panel-name">
        <span className="mono">{ref.technicalName}</span>
      </Title>
      {ref.businessName && <Text>{ref.businessName}</Text>}

      <div className="object-panel-flags">
        {node.output && <Tag design="Positive">Output of this pipeline</Tag>}
        {node.entry && <Tag design="Information">Entry table: fixtures go here</Tag>}
        {node.excluded && <Tag design="Neutral">Excluded writer</Tag>}
        {node.measurement?.measurable && <Tag design="Information">Measurable by snapshots</Tag>}
      </div>
      {node.measurement && !node.measurement.measurable && <Text className="muted">{whyNotMeasurable(node.measurement.reason, ref)}</Text>}
      {node.severalWriters && (
        <MessageStrip design="Critical" hideCloseButton>
          Several flows write this table, and all of them were followed. Select the writer that belongs to another process and exclude it.
        </MessageStrip>
      )}
      {node.inLoop && (
        <MessageStrip design="Negative" hideCloseButton>
          This object is part of a loop, so the order of the steps around it can't be determined.
        </MessageStrip>
      )}

      <div className="object-panel-actions">
        {onExclude && node.competingWriter && !node.excluded && (
          <Button icon="hide" onClick={onExclude}>
            Exclude this writer
          </Button>
        )}
        {onFollow && node.excluded && (
          <Button icon="show" onClick={onFollow}>
            Follow this writer again
          </Button>
        )}
        {onShowPipeline && !node.output && (
          <Button icon="chain-link" onClick={onShowPipeline}>
            Pipeline behind this object
          </Button>
        )}
      </div>

      {details.error && (
        <MessageStrip design="Negative" hideCloseButton>
          {details.error.message}
        </MessageStrip>
      )}
      <Links title="Reads from" refs={edges.filter((e) => e.kind === "reads_from" && refKey(e.to) === key).map((e) => e.from)} />
      <Links title="Read by" refs={edges.filter((e) => e.kind === "reads_from" && refKey(e.from) === key).map((e) => e.to)} />
      <Links title="Written by" refs={edges.filter((e) => e.kind === "writes_to" && refKey(e.to) === key).map((e) => e.from)} />
      <Links title="Writes to" refs={edges.filter((e) => e.kind === "writes_to" && refKey(e.from) === key).map((e) => e.to)} />
      <Links title="Run by task chains" refs={edges.filter((e) => e.kind === "triggers" && refKey(e.to) === key).map((e) => e.from)} />
      <Links title="Cleared by task chains" refs={edges.filter((e) => e.kind === "clears" && refKey(e.to) === key).map((e) => e.from)} />

      <Panel headerText="Definition (as the CLI returned it)" collapsed fixed={false} className="object-panel-definition">
        {details.isPending ? <Text>Loading…</Text> : <pre className="mono">{JSON.stringify(details.data?.object.definition, null, 2)}</pre>}
      </Panel>
    </aside>
  );
}

/** A labelled list of objects; the whole scan's links, not only those inside the pipeline. */
function Links({ title, refs }: { title: string; refs: DspObjectRef[] }) {
  if (refs.length === 0) return null;
  return (
    <section className="object-panel-links">
      <Title level="H3" size="H6">
        {title}
      </Title>
      <ul>
        {refs.map((r) => (
          <li key={refKey(r)}>
            <span className="mono">{r.technicalName}</span> <span className="muted">{typeLabel(r.type)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
