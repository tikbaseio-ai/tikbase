// Opportunity presets over a ranked pool. Pure.
//
// The pool is the stored top-N of rankings_cache (400 rows per niche and
// window), NOT the whole catalogue: that is all we hold enriched. Every preset
// therefore means "among the top 400 by 30-day revenue", and the endpoint says
// so rather than presenting a subset as the market.
//
// What is deliberately NOT here: a commission-rate filter. products.commission_rate
// is populated for almost nothing and never above zero (probe fb8c4ed, see
// migrations/manual/2026-07-30-product-window-stats.sql), so a "decent
// commission" filter would silently match nothing or lie. The honest stand-in
// is affiliate_intensity - the share of the window's videos labelled "Creator
// earns commission" - and it is described as that.

import type { Trend } from './trend-math.js';

export const PRESET_IDS = ['high-potential', 'rapid-growth', 'new'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const RAPID_MIN_GROWTH = 0.5; // +50% vs the previous equal window
export const RAPID_MIN_UNITS = 20; // and a real volume behind it
export const NEW_WITHIN_DAYS = 30;

export interface PoolRow {
  product_id: string;
  created_at?: string | null;
  metrics?: { estRevenue?: number | null; hasRealDelta?: boolean } | null;
  distinct_creators?: number | null;
  affiliate_intensity?: number | null;
  [k: string]: unknown;
}

export interface PresetResult<R> {
  rows: R[];
  /** pool rows the preset could evaluate / could not (growth presets need history) */
  evaluated: number;
  unevaluated: number;
  criteria: string;
}

const median = (xs: number[]): number | null =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;

const rev = (r: PoolRow) => Number(r.metrics?.estRevenue) || 0;

export function applyPreset<R extends PoolRow>(
  id: PresetId,
  pool: R[],
  trends: Map<string, Trend>,
  range: number,
  now: number,
): PresetResult<R> {
  const growthOf = (r: R) => {
    const t = trends.get(String(r.product_id));
    return t && t.status === 'ok' ? t : null;
  };
  const evaluated = pool.filter((r) => growthOf(r)).length;

  if (id === 'rapid-growth') {
    const rows = pool
      .filter((r) => {
        const t = growthOf(r);
        return !!t && t.growth! >= RAPID_MIN_GROWTH && (t.units ?? 0) >= RAPID_MIN_UNITS;
      })
      .sort((a, b) => growthOf(b)!.growth! - growthOf(a)!.growth!);
    return {
      rows, evaluated, unevaluated: pool.length - evaluated,
      criteria:
        `Units sold in the last ${range} days up at least ${RAPID_MIN_GROWTH * 100}% on the ${range} days before, ` +
        `with at least ${RAPID_MIN_UNITS} units, measured from daily sales snapshots. Fastest first.`,
    };
  }

  if (id === 'high-potential') {
    const revFloor = median(pool.map(rev).filter((v) => v > 0));
    const creatorCeil = median(
      pool.map((r) => r.distinct_creators).filter((v): v is number => v != null),
    );
    const rows = pool
      .filter((r) => {
        const t = growthOf(r);
        return (
          !!t && t.growth! >= 0 &&
          r.metrics?.hasRealDelta === true &&
          revFloor != null && rev(r) >= revFloor &&
          creatorCeil != null && r.distinct_creators != null && r.distinct_creators <= creatorCeil &&
          r.affiliate_intensity != null && r.affiliate_intensity > 0
        );
      })
      // Revenue each creator is splitting: the headroom signal.
      .sort(
        (a, b) =>
          rev(b) / Math.max(1, b.distinct_creators ?? 1) -
          rev(a) / Math.max(1, a.distinct_creators ?? 1),
      );
    return {
      rows, evaluated, unevaluated: pool.length - evaluated,
      criteria:
        'Measured sales at or above the median of this list, not shrinking over ' +
        `${range} days, fewer creators than the median, and videos already carrying the ` +
        '"Creator earns commission" label (TikTok does not publish commission rates). ' +
        'Ranked by revenue per creator.',
    };
  }

  // 'new': first seen by TikBase recently. Not the product's launch date - we
  // do not have one - so the label says so.
  const cutoff = now - NEW_WITHIN_DAYS * 86_400_000;
  const rows = pool
    .filter((r) => {
      const t = r.created_at ? Date.parse(r.created_at) : NaN;
      return !Number.isNaN(t) && t >= cutoff && t <= now;
    })
    .sort((a, b) => rev(b) - rev(a));
  return {
    rows, evaluated: pool.length, unevaluated: 0,
    criteria:
      `First seen by TikBase in the last ${NEW_WITHIN_DAYS} days, ranked by revenue. ` +
      'This is when we first tracked it, not its TikTok launch date.',
  };
}

export const isPresetId = (v: unknown): v is PresetId =>
  typeof v === 'string' && (PRESET_IDS as readonly string[]).includes(v);
