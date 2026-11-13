import type { TrendPoint } from '@/lib/trends';

/**
 * Units-per-day line for one product. Pure SVG: a list of 50 rows should not
 * mount 50 chart instances.
 *
 * Colour comes from currentColor, so the caller sets it with text-primary and
 * the accent stays defined in exactly one place (--primary).
 *
 * Fewer than 3 points is not a trend. It renders an em dash rather than a
 * two-point line that looks like a finding.
 */
export function Sparkline({
  points,
  width = 88,
  height = 28,
  className = 'text-primary',
}: {
  points: TrendPoint[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 3) {
    return <span className="text-zinc-600 text-xs font-mono" title="Not enough daily snapshots to draw a trend.">—</span>;
  }
  const pad = 2;
  const max = Math.max(...points.map((p) => p.u), 1);
  const x = (i: number) => pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (u: number) => height - pad - (u / max) * (height - pad * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.u).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`inline-block ${className}`}
      role="img"
      aria-label={`Units sold per day, ${points.length} snapshots, latest ${last.u}`}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last.u)} r={2} fill="currentColor" />
    </svg>
  );
}
