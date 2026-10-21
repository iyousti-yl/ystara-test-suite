import dagre from "@dagrejs/dagre";

/**
 * Places a lineage picture from left (sources) to right (the output) with
 * dagre, the layered-graph layout that most lineage tools use. Returns the
 * top-left corner of each node, which is what React Flow expects.
 */
export const NODE_HEIGHT = 88;
export const NODE_MIN_WIDTH = 240;
export const NODE_MAX_WIDTH = 480;

/**
 * Wide enough for the whole technical name, and for the type line and
 * business name up to NODE_MAX_WIDTH (longer ones are cut off; hovering shows
 * them). Estimated from the fonts in app.css rather than measured, so the
 * layout doesn't wait for fonts. Per character: the name (IBM Plex Mono 12px,
 * every character 0.6em) 7.2px, the type line (Plex Mono 11px capitals,
 * spaced 0.12em) 7.92px, the business name (Plex Sans 12px) about 6.4px.
 */
export function nodeWidth(lines: { type: string; technicalName: string; businessName?: string }): number {
  const text = Math.max(lines.technicalName.length * 7.2, lines.type.length * 7.92, (lines.businessName?.length ?? 0) * 6.4);
  const padding = 30; // .lineage-node padding and borders
  return Math.ceil(Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, text + padding)));
}

export function layoutLeftToRight(nodes: { key: string; width: number }[], links: [from: string, to: string][]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 80, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const { key, width } of nodes) g.setNode(key, { width, height: NODE_HEIGHT });
  for (const [from, to] of links) if (g.hasNode(from) && g.hasNode(to)) g.setEdge(from, to);
  dagre.layout(g);

  return new Map(
    nodes.map(({ key, width }) => {
      const { x, y } = g.node(key);
      return [key, { x: x! - width / 2, y: y! - NODE_HEIGHT / 2 }];
    }),
  );
}
