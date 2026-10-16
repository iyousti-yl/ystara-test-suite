import { describe, expect, it } from "vitest";
import { layoutLeftToRight, NODE_HEIGHT } from "./layout";
import { cardPosition, MIN_FIT_ZOOM, openingViewport, READABLE_ZOOM, type Box, type Viewport } from "./viewport";

/** A synthetic pipeline laid out as the app does: one width per node, each column feeding the first node of the next. */
function pipeline(columns: number[][]): { nodes: Box[]; output: Box } {
  const keys = columns.map((widths, c) => widths.map((width, i) => ({ key: `N${c}_${i}`, width })));
  const links = keys.slice(0, -1).flatMap((column, c) => column.map((n): [string, string] => [n.key, keys[c + 1][0].key]));
  const at = layoutLeftToRight(keys.flat(), links);
  const nodes = keys.flat().map(({ key, width }) => ({ ...at.get(key)!, width, height: NODE_HEIGHT }));
  return { nodes, output: nodes.at(-1)! };
}

const onCanvas = (b: Box, v: Viewport) => ({ left: v.x + b.x * v.zoom, right: v.x + (b.x + b.width) * v.zoom });

describe("opening view", () => {
  // Eight columns of 240px nodes: about 2.5 times the width of a 1000px canvas.
  const eight = pipeline([[240, 240], [240], [240, 240, 240], [240], [240, 240], [240], [240], [240]]);

  it("shows the whole pipeline when it fits at MIN_FIT_ZOOM or more", () => {
    const v = openingViewport(eight.nodes, eight.output, { width: 1200, height: 700 });
    expect(v.zoom).toBeGreaterThanOrEqual(MIN_FIT_ZOOM);
    expect(v.zoom).toBeLessThan(READABLE_ZOOM);
    for (const n of eight.nodes) {
      const { left, right } = onCanvas(n, v);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(1200);
    }
  });

  it("otherwise shows whole columns from the output end, at a readable size", () => {
    for (const width of [700, 1000, 1100]) {
      const v = openingViewport(eight.nodes, eight.output, { width, height: 700 });
      expect(v.zoom, `${width}px`).toBeGreaterThanOrEqual(READABLE_ZOOM);
      expect(onCanvas(eight.output, v).right, `${width}px`).toBeLessThanOrEqual(width);
      for (const n of eight.nodes) {
        const { left, right } = onCanvas(n, v);
        const cut = left < 0 && right > 0;
        expect(cut, `${width}px: a node from ${left} to ${right}`).toBe(false);
      }
    }
  });

  it("keeps columns whole when their nodes have different widths", () => {
    const mixed = pipeline([[240], [480, 240], [300], [240, 420], [240], [360], [240]]);
    const v = openingViewport(mixed.nodes, mixed.output, { width: 900, height: 700 });
    for (const n of mixed.nodes) {
      const { left, right } = onCanvas(n, v);
      expect(left < 0 && right > 0).toBe(false);
    }
    expect(onCanvas(mixed.output, v).right).toBeLessThanOrEqual(900);
  });
});

describe("hover card", () => {
  const canvas = { width: 1000, height: 600 };
  const card = { width: 300, height: 60 };

  it("sits centred above the node", () => {
    expect(cardPosition({ x: 400, y: 300, width: 200, height: 50 }, card, canvas)).toEqual({ left: 350, top: 232 });
  });

  it("stays inside the canvas next to an edge, and goes below a node at the top", () => {
    expect(cardPosition({ x: -30, y: 300, width: 120, height: 40 }, card, canvas).left).toBe(8);
    expect(cardPosition({ x: 950, y: 300, width: 120, height: 40 }, card, canvas).left).toBe(1000 - 300 - 8);
    expect(cardPosition({ x: 400, y: 10, width: 200, height: 50 }, card, canvas).top).toBe(10 + 50 + 8);
  });
});
