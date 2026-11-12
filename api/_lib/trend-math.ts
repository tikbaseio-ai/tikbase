// Sales trend maths over product_snapshots. Pure: no I/O, so it is testable and
// so the same rules apply to the list sparkline, the preset filters and the
// product-page chart.
//
// The only history we hold is one cumulative `sold_count` per product per
// snapshot date, and only for products the nightly job tracks (hot set plus a
// rotation tail, see probes/SNAPSHOT-COVERAGE.md). Everything below is derived
// from that and nothing else, which sets the honesty rules:
//
//   - a reading of 0 is a MISSING reading, not "sold nothing" (the estimator in
//     api/top-products.ts learned this the expensive way), so it is dropped;
//   - we never invent a boundary: a window edge is the real snapshot or a linear
//     interpolation across a gap of at most MAX_GAP_DAYS, otherwise it is null;
//   - growth is null, with a stated reason, rather than 0% when it cannot be
//     measured. "0% growth" asserts flat sales; null asserts we do not know.

export const TREND_RANGES = [7, 30, 90] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

/** Widest hole we will bridge by interpolation. Rotation-tail products are
 *  snapshotted less than daily; beyond this the edge is unknown, not guessed. */
export const MAX_GAP_DAYS = 7;

/** Prior-window units below which a percentage is noise (1 -> 10 is "+900%"). */
export const MIN_PRIOR_UNITS = 10;

/** A newest snapshot older than this means the product fell out of the refresh;
 *  its "recent" trend would really be an old one. */
export const MAX_STALE_DAYS = 7;

export interface SoldPoint {
  /** YYYY-MM-DD */
  date: string;
  sold: number | null;
  price: number | null;
}

export type TrendStatus =
  | 'ok'
  | 'no-history' // no usable snapshot rows
  | 'stale' // newest snapshot older than MAX_STALE_DAYS
  | 'short-history' // current window measured, prior window not covered
  | 'too-few-sales'; // prior window measured but under MIN_PRIOR_UNITS

export interface TrendDay {
  /** snapshot date this rate ends on */
  d: string;
  /** units sold per day since the previous snapshot */
  u: number;
  /** estimated revenue per day: u x the listed price on that snapshot. null when
   *  the snapshot carried no price. */
  r: number | null;
  /** days since the previous snapshot; >1 means u is an average over a gap */
  gap: number;
}

export interface Trend {
  range: TrendRange;
  status: TrendStatus;
  /** newest snapshot date used, null with no history */
  asOf: string | null;
  /** days between the oldest and newest snapshot we hold */
  historyDays: number;
  /** units in the most recent `range` days, null when an edge is unknown */
  units: number | null;
  /** units in the `range` days before that */
  priorUnits: number | null;
  /** (units - priorUnits) / priorUnits, a fraction (0.5 = +50%). null unless ok */
  growth: number | null;
  points: TrendDay[];
}

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function clean(raw: SoldPoint[]): { t: number; date: string; sold: number; price: number | null }[] {
  const byDate = new Map<string, { t: number; date: string; sold: number; price: number | null }>();
  for (const p of raw) {
    if (!p || typeof p.date !== 'string') continue;
    const t = dayMs(p.date);
    const sold = Number(p.sold);
    if (Number.isNaN(t) || !(sold > 0)) continue; // 0 / null = missing reading
    const price = p.price != null && Number(p.price) > 0 ? Number(p.price) : null;
    byDate.set(p.date, { t, date: p.date, sold, price });
  }
  return [...byDate.values()].sort((a, b) => a.t - b.t);
}

/** Cumulative sold at time t: a real snapshot, or interpolated across a short gap. */
function cumulativeAt(pts: { t: number; sold: number }[], t: number): number | null {
  let before: { t: number; sold: number } | null = null;
  let after: { t: number; sold: number } | null = null;
  for (const p of pts) {
    if (p.t <= t) before = p;
    if (p.t >= t) {
      after = p;
      break;
    }
  }
  if (!before || !after) return null;
  if (before.t === after.t) return before.sold;
  if ((after.t - before.t) / DAY > MAX_GAP_DAYS) return null;
  return before.sold + ((after.sold - before.sold) * (t - before.t)) / (after.t - before.t);
}

const delta = (end: number | null, start: number | null): number | null =>
  end == null || start == null ? null : Math.max(0, Math.round(end - start));

/**
 * @param raw   snapshot rows for one product, any order
 * @param range days in each of the two compared windows
 * @param today YYYY-MM-DD, injected so tests do not depend on the clock
 */
export function computeTrend(raw: SoldPoint[], range: TrendRange, today: string): Trend {
  const empty: Trend = {
    range, status: 'no-history', asOf: null, historyDays: 0,
    units: null, priorUnits: null, growth: null, points: [],
  };
  const pts = clean(raw);
  if (pts.length < 2) return pts.length ? { ...empty, asOf: pts[0].date } : empty;

  const latest = pts[pts.length - 1];
  const historyDays = Math.round((latest.t - pts[0].t) / DAY);
  const base = { ...empty, asOf: latest.date, historyDays };

  const endT = latest.t;
  const startT = endT - range * DAY;
  const priorStartT = endT - 2 * range * DAY;

  // Per-snapshot rates inside the current window. The first point after the
  // window opens needs a predecessor, which may sit before it.
  const points: TrendDay[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t <= startT) continue;
    const gap = Math.round((pts[i].t - pts[i - 1].t) / DAY);
    if (gap < 1) continue;
    const u = Math.max(0, pts[i].sold - pts[i - 1].sold) / gap;
    points.push({
      d: pts[i].date,
      u: Math.round(u * 10) / 10,
      r: pts[i].price != null ? Math.round(u * pts[i].price! * 100) / 100 : null,
      gap,
    });
  }

  if ((today ? (dayMs(today) - endT) / DAY : 0) > MAX_STALE_DAYS) {
    return { ...base, status: 'stale', points };
  }

  const cEnd = cumulativeAt(pts, endT);
  const units = delta(cEnd, cumulativeAt(pts, startT));
  const priorUnits = delta(cumulativeAt(pts, startT), cumulativeAt(pts, priorStartT));

  if (units == null) return { ...base, status: 'short-history', points };
  if (priorUnits == null) return { ...base, status: 'short-history', units, points };
  if (priorUnits < MIN_PRIOR_UNITS) {
    return { ...base, status: 'too-few-sales', units, priorUnits, points };
  }
  return {
    ...base, status: 'ok', units, priorUnits,
    growth: (units - priorUnits) / priorUnits, points,
  };
}

export function parseRange(v: unknown, allowed: readonly number[] = TREND_RANGES): TrendRange | null {
  const n = parseInt(String(v ?? ''), 10);
  return allowed.includes(n) ? (n as TrendRange) : null;
}

/** Days of history to request so both windows plus an interpolation edge exist. */
export const historyNeeded = (range: number) => 2 * range + MAX_GAP_DAYS;

export { isoDay };
