/**
 * Where the lineage picture opens. Pure functions on node boxes (flow
 * coordinates, top-left corner and size) and the canvas size in pixels, so
 * they can be tested without a browser.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Down to this zoom the whole pipeline is shown, its names still readable (12px names at 8px or more). */
export const MIN_FIT_ZOOM = 0.7;
/** When the whole pipeline needs less than MIN_FIT_ZOOM, the output end is shown at least this large. */
export const READABLE_ZOOM = 0.85;
/** Space kept between the picture and the edges of the canvas, in pixels. */
export const MARGIN = 32;

/**
 * The whole pipeline when it fits at MIN_FIT_ZOOM or more. Otherwise as many
 * whole columns as fit at READABLE_ZOOM, counted from the output end (where
 * people start reading), so no column is cut at the left edge; the minimap
 * shows the rest.
 *
 * `minimap` is the minimap's box in canvas pixels, when it is shown. If a
 * node would open under it (a short canvas, the output on the right), the
 * picture opens in the part of the canvas left of the minimap instead, or
 * above it when that shows the picture larger and clears it too.
 */
export function openingViewport(nodes: Box[], output: Box | undefined, canvas: { width: number; height: number }, minimap?: Box): Viewport {
  const view = fitted(nodes, output, canvas);
  if (!minimap || !covers(minimap, nodes, view)) return view;
  const beside = fitted(nodes, output, { width: minimap.x, height: canvas.height });
  const above = fitted(nodes, output, { width: canvas.width, height: minimap.y });
  return above.zoom > beside.zoom && !covers(minimap, nodes, above) ? above : beside;
}

/** Whether `area` (canvas pixels) hides part of a node shown at `view`. */
function covers(area: Box, nodes: Box[], view: Viewport): boolean {
  return nodes.some((n) => {
    const left = view.x + n.x * view.zoom;
    const top = view.y + n.y * view.zoom;
    return left < area.x + area.width && left + n.width * view.zoom > area.x && top < area.y + area.height && top + n.height * view.zoom > area.y;
  });
}

function fitted(nodes: Box[], output: Box | undefined, canvas: { width: number; height: number }): Viewport {
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };
  const all = bounds(nodes);
  const fit = Math.min(1, (canvas.width - 2 * MARGIN) / all.width, (canvas.height - 2 * MARGIN) / all.height);
  if (fit >= MIN_FIT_ZOOM || !output) return showing(all, fit, canvas);

  // dagre puts each step of the chain in a column of nodes that share a centre line; the output's is the last.
  const centre = (b: Box) => Math.round(b.x + b.width / 2);
  const byCentre = new Map<number, Box[]>();
  for (const n of nodes) if (centre(n) <= centre(output)) byCentre.set(centre(n), [...(byCentre.get(centre(n)) ?? []), n]);
  const columns = [...byCentre.values()].map(bounds).sort((a, b) => a.x - b.x);
  const right = columns.at(-1)!.x + columns.at(-1)!.width;

  // Add columns leftwards while the span still fits at a readable zoom; the output's column always shows.
  let first = columns.length - 1;
  while (first > 0 && (right - columns[first - 1].x) * READABLE_ZOOM <= canvas.width - 2 * MARGIN) first--;
  const span = bounds(columns.slice(first));
  const zoom = Math.min(1, (canvas.width - 2 * MARGIN) / span.width);
  // Left-aligned, so whatever room is left over goes to the right of the output, never to a cut column.
  return { x: MARGIN - span.x * zoom, y: canvas.height / 2 - (span.y + span.height / 2) * zoom, zoom };
}

/** `box` centred on the canvas at `zoom`. */
function showing(box: Box, zoom: number, canvas: { width: number; height: number }): Viewport {
  return {
    x: canvas.width / 2 - (box.x + box.width / 2) * zoom,
    y: canvas.height / 2 - (box.y + box.height / 2) * zoom,
    zoom,
  };
}

function bounds(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/**
 * Where to put a card of `card` size about a node shown at `node` (both in
 * canvas pixels): centred above it, or below when there is no room above,
 * and always inside the canvas.
 */
export function cardPosition(node: Box, card: { width: number; height: number }, canvas: { width: number; height: number }, gap = 8): { left: number; top: number } {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
  const left = clamp(node.x + node.width / 2 - card.width / 2, gap, canvas.width - card.width - gap);
  const above = node.y - card.height - gap;
  const top = above >= gap ? above : node.y + node.height + gap;
  return { left, top: clamp(top, gap, canvas.height - card.height - gap) };
}
