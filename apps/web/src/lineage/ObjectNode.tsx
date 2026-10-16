import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { typeColor, typeLabel } from "../objectTypes";
import type { LineageNode } from "./model";

/** One object in the lineage picture: its type, names, and what is special about it. */
export type ObjectNodeType = Node<{ node: LineageNode; multiSpace: boolean; width: number }, "object">;

export function ObjectNode({ data, selected }: NodeProps<ObjectNodeType>) {
  const { ref, output, entry, excluded, severalWriters, inLoop } = data.node;
  const classes = ["lineage-node", selected && "is-selected", excluded && "is-excluded", output && "is-output"].filter(Boolean).join(" ");
  return (
    <div className={classes} style={{ width: data.width, borderLeftColor: typeColor(ref.type) }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="lineage-node-type" style={{ color: typeColor(ref.type) }}>
        {typeLabel(ref.type)}
        {data.multiSpace && <span className="lineage-node-space"> · {ref.space}</span>}
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
    </div>
  );
}

/** Whether a name on the node (an element containing it) is cut off with an ellipsis. */
export function hasCutOffText(node: HTMLElement): boolean {
  return [...node.querySelectorAll<HTMLElement>(".lineage-node-type, .lineage-node-name, .lineage-node-business")].some((el) => el.scrollWidth > el.clientWidth);
}
