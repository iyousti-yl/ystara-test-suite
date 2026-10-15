import dagre from "@dagrejs/dagre";

/**
 * Places a lineage picture from left (sources) to right (the output) with
 * dagre, the layered-graph layout that most lineage tools use. Returns the
 * top-left corner of each node, which is what React Flow expects.
 */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 76;

export function layoutLeftToRight(keys: string[], links: [from: string, to: string][]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 80, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const key of keys) g.setNode(key, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const [from, to] of links) if (g.hasNode(from) && g.hasNode(to)) g.setEdge(from, to);
  dagre.layout(g);

  return new Map(
    keys.map((key) => {
      const { x, y } = g.node(key);
      return [key, { x: x! - NODE_WIDTH / 2, y: y! - NODE_HEIGHT / 2 }];
    }),
  );
}
