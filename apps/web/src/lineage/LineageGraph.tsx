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
import { OBJECT_TYPE, typeLabel } from "../objectTypes";
import { layoutLeftToRight, NODE_HEIGHT, NODE_MIN_WIDTH, nodeWidth } from "./layout";
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
 * Each node is as wide as its names need (nodeWidth in layout.ts).
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

  const widths = useMemo(
    () =>
      new Map(
        nodes.map(({ key, ref }) => [
          key,
          nodeWidth({ type: typeLabel(ref.type) + (multiSpace ? ` · ${ref.space}` : ""), technicalName: ref.technicalName, businessName: ref.businessName }),
        ]),
      ),
    [nodes, multiSpace],
  );
  const positions = useMemo(
    () =>
      layoutLeftToRight(
        nodes.map((n) => ({ key: n.key, width: widths.get(n.key)! })),
        edges.map((e) => [e.from, e.to]),
      ),
    [nodes, edges, widths],
  );

  const flowNodes = useMemo<ObjectNodeType[]>(
    () =>
      nodes.map((node) => ({
        id: node.key,
        type: "object",
        position: positions.get(node.key)!,
        data: { node, multiSpace, width: widths.get(node.key)! },
        selected: node.key === selected,
      })),
    // Only the first value matters (defaultNodes); `selected` is left out so a click doesn't rebuild the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, positions, widths, multiSpace],
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
      <KeepInView selected={selected} />
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
      const outputRight = output.position.x + (output.measured?.width ?? NODE_MIN_WIDTH);
      return flow.setCenter(outputRight + 48 - visibleWidth / 2, output.position.y + NODE_HEIGHT / 2, { zoom: READABLE_ZOOM });
    });
  }, [measured, flow, outputKey, width]);
  return null;
}

/** Space kept between the selected object and the edge of the picture. */
const MARGIN = 24;

/**
 * Opening or closing the details panel makes the picture narrower or wider.
 * The panel pushes the picture to the left: its right edge, where the output
 * is, stays where it was. If that hides the selected object on the left, the
 * picture moves just enough to show it. Resizing the window works the same way.
 */
function KeepInView({ selected }: { selected?: string }) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const previousWidth = useRef(width);

  useEffect(() => {
    const before = previousWidth.current;
    previousWidth.current = width;
    if (before === 0 || width === 0 || before === width) return;

    const { y, zoom } = flow.getViewport();
    let x = flow.getViewport().x + (width - before);
    const node = selected ? flow.getNode(selected) : undefined;
    if (node?.measured?.width) {
      const left = x + node.position.x * zoom;
      const right = left + node.measured.width * zoom;
      if (right > width - MARGIN) x -= right - (width - MARGIN);
      else if (left < MARGIN) x += MARGIN - left;
    }
    void flow.setViewport({ x, y, zoom });
  }, [width, selected, flow]);
  return null;
}
