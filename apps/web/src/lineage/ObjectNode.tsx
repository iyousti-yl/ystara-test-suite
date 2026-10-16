import { useState } from "react";
import { Handle, NodeToolbar, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { typeColor, typeLabel } from "../objectTypes";
import type { LineageNode } from "./model";

/** One object in the lineage picture: its type, names, and what is special about it. */
export type ObjectNodeType = Node<{ node: LineageNode; multiSpace: boolean; width: number }, "object">;

/** Below this zoom the names on the nodes are too small to read, so hovering a node shows them at full size. */
const CARD_BELOW_ZOOM = 0.8;

export function ObjectNode({ data, selected }: NodeProps<ObjectNodeType>) {
  const { ref, output, entry, excluded, severalWriters, inLoop } = data.node;
  const [hovered, setHovered] = useState(false);
  const [cutOff, setCutOff] = useState(false);
  const zoomedOut = useStore((s) => s.transform[2] < CARD_BELOW_ZOOM);
  const classes = ["lineage-node", selected && "is-selected", excluded && "is-excluded", output && "is-output"].filter(Boolean).join(" ");
  const type = (
    <>
      {typeLabel(ref.type)}
      {data.multiSpace && <span className="lineage-node-space"> · {ref.space}</span>}
    </>
  );

  return (
    <div
      className={classes}
      style={{ width: data.width, borderLeftColor: typeColor(ref.type) }}
      onMouseEnter={(e) => {
        setCutOff(hasCutOffText(e.currentTarget));
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="lineage-node-type" style={{ color: typeColor(ref.type) }}>
        {type}
      </div>
      <div className="lineage-node-name">{ref.technicalName}</div>
      {ref.businessName && <div className="lineage-node-business">{ref.businessName}</div>}
      <div className="lineage-node-flags">
        {output && <span className="flag flag-output">Output</span>}
        {entry && <span className="flag flag-entry">Entry</span>}
        {excluded && <span className="flag flag-muted">Excluded</span>}
        {severalWriters && <span className="flag flag-warning">Several writers</span>}
        {inLoop && <span className="flag flag-error">Loop</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />

      {/* Drawn outside the zoomed picture, so it is full size at any zoom. */}
      <NodeToolbar isVisible={hovered && (zoomedOut || cutOff)} position={Position.Top} className="lineage-card">
        <div className="lineage-node-type" style={{ color: typeColor(ref.type) }}>
          {type}
        </div>
        <div className="lineage-card-name">{ref.technicalName}</div>
        {ref.businessName && <div className="lineage-card-business">{ref.businessName}</div>}
      </NodeToolbar>
    </div>
  );
}

/** Whether a name on the node is cut off with an ellipsis. */
function hasCutOffText(node: HTMLElement): boolean {
  return [...node.querySelectorAll<HTMLElement>(".lineage-node-type, .lineage-node-name, .lineage-node-business")].some((el) => el.scrollWidth > el.clientWidth);
}
