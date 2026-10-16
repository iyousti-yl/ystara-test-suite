import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { OBJECT_TYPE, typeColor, typeLabel } from "../objectTypes";
import { layoutLeftToRight, nodeWidth } from "./layout";
import type { LineageEdge, LineageNode } from "./model";
import { hasCutOffText, ObjectNode, type ObjectNodeType } from "./ObjectNode";
import { cardPosition, MARGIN, openingViewport, type Box } from "./viewport";

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
  const [hovered, setHovered] = useState<{ key: string; cutOff: boolean }>();
  const hoveredNode = hovered && nodes.find((n) => n.key === hovered.key);

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
      onNodeMouseEnter={(event, node) => setHovered({ key: node.id, cutOff: hasCutOffText(event.currentTarget as HTMLElement) })}
      onNodeMouseLeave={() => setHovered(undefined)}
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
      {hovered && hoveredNode && <HoverCard node={hoveredNode} cutOff={hovered.cutOff} multiSpace={multiSpace} />}
    </ReactFlow>
  );
}

/**
 * The first view: the whole pipeline when it fits at a readable size,
 * otherwise whole columns from its output end (openingViewport in viewport.ts).
 */
function OpeningView({ outputKey }: { outputKey?: string }) {
  const flow = useReactFlow();
  const measured = useNodesInitialized();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const done = useRef(false);

  useEffect(() => {
    if (!measured || done.current || width === 0 || height === 0) return;
    done.current = true;
    const output = outputKey ? flow.getNode(outputKey) : undefined;
    void flow.setViewport(openingViewport(flow.getNodes().map(box), output && box(output), { width, height }));
  }, [measured, flow, outputKey, width, height]);
  return null;
}

const box = (n: Node): Box => ({ ...n.position, width: n.measured?.width ?? 0, height: n.measured?.height ?? 0 });

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

/** Below this zoom the names on the nodes are too small to read, so hovering a node shows them at full size. */
const CARD_BELOW_ZOOM = 0.8;

/**
 * The hovered object's names at full size, when the picture is zoomed out or
 * a name is cut off. Drawn over the canvas rather than inside the zoomed
 * picture, and placed so it stays inside the canvas (cardPosition).
 */
function HoverCard({ node, cutOff, multiSpace }: { node: LineageNode; cutOff: boolean; multiSpace: boolean }) {
  const flow = useReactFlow();
  const [x, y, zoom] = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const card = useRef<HTMLDivElement>(null);

  // Placed once the card has its size, before the browser paints it.
  useLayoutEffect(() => {
    const el = card.current;
    const shown = flow.getNode(node.key);
    if (!el || !shown?.measured?.width || !shown.measured.height) return;
    const onCanvas = { x: x + shown.position.x * zoom, y: y + shown.position.y * zoom, width: shown.measured.width * zoom, height: shown.measured.height * zoom };
    const at = cardPosition(onCanvas, { width: el.offsetWidth, height: el.offsetHeight }, { width, height });
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
  }, [flow, node.key, x, y, zoom, width, height]);

  if (zoom >= CARD_BELOW_ZOOM && !cutOff) return null;
  const { ref } = node;
  return (
    <div ref={card} className="lineage-card" role="tooltip">
      <div className="lineage-node-type" style={{ color: typeColor(ref.type) }}>
        {typeLabel(ref.type)}
        {multiSpace && <span className="lineage-node-space"> · {ref.space}</span>}
      </div>
      <div className="lineage-card-name">{ref.technicalName}</div>
      {ref.businessName && <div className="lineage-card-business">{ref.businessName}</div>}
    </div>
  );
}
