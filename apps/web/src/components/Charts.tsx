import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { appLocale } from "../format";

/**
 * Two small charts in the brand's colours, drawn as SVG at the size of their
 * box: columns (one per run, such as a suite's share of passing scenarios)
 * and a line (a value per snapshot). One series each, so the title names it
 * and there is no legend; the latest value is labelled, the rest is in the
 * tooltip (on hover and on keyboard focus) and in the table beside the chart.
 */
export interface ChartPoint {
  key: string;
  value: number;
  /** The tooltip's lines: the value first, then what it is. */
  tooltip: [string, string];
}

const HEIGHT = 168;
const PAD = { top: 20, right: 16, bottom: 12, left: 44 };

/** The box's width, kept up to date. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Round ticks from 0: the top rounded up to 1, 2 or 5 times a power of ten, and its half when that is a whole number. */
export function ticksFor(max: number): number[] {
  if (max <= 0) return [0, 1];
  const power = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map((m) => m * power).find((t) => t >= max)!;
  return Number.isInteger(top / 2) ? [0, top / 2, top] : [0, top];
}

const compact = new Intl.NumberFormat(appLocale(), { notation: "compact", maximumFractionDigits: 1 });
export const formatCompact = (n: number) => compact.format(n);

function Frame(props: {
  label: string;
  width: number;
  ticks: number[];
  tickText: (n: number) => string;
  y: (n: number) => number;
  children: ReactNode;
  hovered?: ChartPoint;
  tipX?: number;
}) {
  const { width, ticks, y } = props;
  return (
    <>
      <svg width={width} height={HEIGHT} role="img" aria-label={props.label} className="chart-svg">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">
              {props.tickText(t)}
            </text>
          </g>
        ))}
        {props.children}
      </svg>
      {props.hovered && props.tipX !== undefined && (
        <div className="chart-tooltip" style={{ left: Math.min(Math.max(props.tipX, 70), width - 70) }} role="status">
          <strong>{props.hovered.tooltip[0]}</strong>
          <span>{props.hovered.tooltip[1]}</span>
        </div>
      )}
    </>
  );
}

/** A column per point, oldest left, from a baseline at 0 to `max` (such as 100 for a share). */
export function ColumnChart({ label, points, max, tickText, endLabel }: { label: string; points: ChartPoint[]; max: number; tickText: (n: number) => string; endLabel: string }) {
  const { ref, width } = useWidth();
  const [hovered, setHovered] = useState<number>();
  const ticks = ticksFor(max);
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (n: number) => PAD.top + plotH - (n / top) * plotH;
  const band = points.length ? plotW / points.length : 0;
  const barW = Math.min(24, Math.max(4, band - 2));
  const x = (i: number) => PAD.left + band * i + (band - barW) / 2;
  const point = hovered === undefined ? undefined : points[hovered];

  return (
    <div ref={ref} className="chart" onPointerLeave={() => setHovered(undefined)}>
      {width > 0 && (
        <Frame label={label} width={width} ticks={ticks} tickText={tickText} y={y} hovered={point} tipX={hovered === undefined ? undefined : x(hovered) + barW / 2}>
          {points.map((p, i) => {
            const h = Math.max(0, y(0) - y(p.value));
            const r = Math.min(4, h, barW / 2);
            const left = x(i);
            const right = left + barW;
            const base = y(0);
            const capped = `M${left},${base} V${base - h + r} Q${left},${base - h} ${left + r},${base - h} H${right - r} Q${right},${base - h} ${right},${base - h + r} V${base} Z`;
            return (
              <g key={p.key} className={hovered === i ? "chart-mark is-hovered" : "chart-mark"}>
                {h > 0 ? (
                  <path d={capped} className="chart-column" />
                ) : (
                  // A run at zero still shows, as a short mark on the baseline.
                  <rect x={left} y={base - 2} width={barW} height={2} className="chart-column-zero" />
                )}
                {/* The whole band is the hit target, not only the painted column. */}
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  className="chart-hit"
                  tabIndex={0}
                  aria-label={`${p.tooltip[0]}, ${p.tooltip[1]}`}
                  onPointerEnter={() => setHovered(i)}
                  onFocus={() => setHovered(i)}
                  onBlur={() => setHovered(undefined)}
                />
              </g>
            );
          })}
          {points.length > 0 && (
            <text x={x(points.length - 1) + barW / 2} y={y(points[points.length - 1].value) - 6} textAnchor="middle" className="chart-label">
              {endLabel}
            </text>
          )}
        </Frame>
      )}
    </div>
  );
}

/** A 2px line through a point per value, oldest left, with a crosshair that snaps to the nearest point. */
export function LineChart({ label, points, endLabel }: { label: string; points: ChartPoint[]; endLabel: string }) {
  const { ref, width } = useWidth();
  const [hovered, setHovered] = useState<number>();
  const max = Math.max(0, ...points.map((p) => p.value));
  const ticks = ticksFor(max);
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (n: number) => PAD.top + plotH - (n / top) * plotH;
  const x = (i: number) => (points.length === 1 ? PAD.left + plotW / 2 : PAD.left + (plotW * i) / (points.length - 1));
  const point = hovered === undefined ? undefined : points[hovered];
  const nearest = (clientX: number, box: DOMRect) => {
    const at = clientX - box.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - at) < Math.abs(x(best) - at)) best = i;
    return best;
  };
  const step = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const from = hovered ?? points.length - 1;
    setHovered(Math.min(points.length - 1, Math.max(0, from + (e.key === "ArrowRight" ? 1 : -1))));
  };

  return (
    <div ref={ref} className="chart" onPointerLeave={() => setHovered(undefined)}>
      {width > 0 && (
        <Frame label={label} width={width} ticks={ticks} tickText={formatCompact} y={y} hovered={point} tipX={hovered === undefined ? undefined : x(hovered)}>
          {hovered !== undefined && <line x1={x(hovered)} x2={x(hovered)} y1={PAD.top} y2={y(0)} className="chart-crosshair" />}
          <polyline points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} className="chart-line" />
          {points.map((p, i) => (
            <circle key={p.key} cx={x(i)} cy={y(p.value)} r={hovered === i ? 5 : 4} className="chart-dot" />
          ))}
          {points.length > 0 && (
            <text x={x(points.length - 1)} y={y(points[points.length - 1].value) - 10} textAnchor="end" className="chart-label">
              {endLabel}
            </text>
          )}
          <rect
            x={PAD.left - 12}
            y={PAD.top}
            width={plotW + 24}
            height={plotH}
            className="chart-hit"
            tabIndex={0}
            aria-label={`${label}: use the arrow keys to read each value`}
            onPointerMove={(e) => setHovered(nearest(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect()))}
            onFocus={() => setHovered(points.length - 1)}
            onBlur={() => setHovered(undefined)}
            onKeyDown={step}
          />
        </Frame>
      )}
    </div>
  );
}
