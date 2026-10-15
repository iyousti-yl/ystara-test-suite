import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { OBJECT_TYPE } from "../objectTypes";
import { layoutLeftToRight, NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { LineageEdge, LineageNode } from "./model";
import { ObjectNode, type ObjectNodeType } from "./ObjectNode";

const nodeTypes = { object: ObjectNode };

/**
 * The lineage picture: sources on the left, the output on the right, laid out
 * by dagre and drawn by React Flow (pan, zoom, minimap). Clicking an object
 * selects it; the page shows its details.
 *
 * React Flow keeps the nodes itself (defaultNodes): it measures them and
 * tracks the selection. A different set of objects mounts a fresh picture.
 */
export function LineageGraph(props: {
  nodes: LineageNode[];
  edges: LineageEdge[];
  selected?: string;
  onSelect: (key: string | undefined) => void;
  dark: boolean;
}) {
  const { nodes, edges, selected, onSelect, dark } = props;
  const multiSpace = new Set(nodes.map((n) => n.ref.space)).size > 1;

  const positions = useMemo(
    () =>
      layoutLeftToRight(
        nodes.map((n) => n.key),
        edges.map((e) => [e.from, e.to]),
      ),
    [nodes, edges],
  );

  const flowNodes = useMemo<ObjectNodeType[]>(
    () =>
      nodes.map((node) => ({
        id: node.key,
        type: "object",
        position: positions.get(node.key)!,
        data: { node, multiSpace },
        selected: node.key === selected,
      })),
    // Only the first value matters (defaultNodes); `selected` is left out so a click doesn't rebuild the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, positions, multiSpace],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.key,
        source: e.from,
        target: e.to,
        className: e.excluded ? "lineage-edge is-excluded" : e.kind === "writes_to" ? "lineage-edge is-write" : "lineage-edge",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        label: e.kind === "writes_to" ? "writes" : undefined,
      })),
    [edges],
  );

  return (
    <ReactFlow
      key={nodes.map((n) => n.key).join()}
      defaultNodes={flowNodes}
      defaultEdges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_event, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(undefined)}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.1}
      colorMode={dark ? "dark" : "light"}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeClassName={(n) => `minimap-${OBJECT_TYPE[(n as ObjectNodeType).data.node.ref.type].category}`} />
      {!selected && <Panel position="top-left" className="lineage-hint">Click an object for its details.</Panel>}
      <OpeningView outputKey={nodes.find((n) => n.output)?.key} />
    </ReactFlow>
  );
}

/** Below this zoom, names can't be read. */
const READABLE_ZOOM = 0.6;

/**
 * The first view: the whole pipeline if it fits at a readable size; otherwise
 * its output end, where people start reading, with the minimap showing the rest.
 */
function OpeningView({ outputKey }: { outputKey?: string }) {
  const flow = useReactFlow();
  const measured = useNodesInitialized();
  const width = useStore((s) => s.width);
  const done = useRef(false);

  useEffect(() => {
    if (!measured || done.current) return;
    done.current = true;
    void flow.fitView({ padding: 0.1, maxZoom: 1 }).then(() => {
      const output = outputKey ? flow.getNode(outputKey) : undefined;
      if (!output || flow.getZoom() >= READABLE_ZOOM) return;
      const visibleWidth = width / READABLE_ZOOM;
      return flow.setCenter(output.position.x + NODE_WIDTH + 48 - visibleWidth / 2, output.position.y + NODE_HEIGHT / 2, { zoom: READABLE_ZOOM });
    });
  }, [measured, flow, outputKey, width]);
  return null;
}
