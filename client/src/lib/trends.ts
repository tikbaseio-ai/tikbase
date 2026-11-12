import { authHeader } from '@/lib/supabase';

export type TrendRange = 7 | 30 | 90;
export const TREND_RANGES: TrendRange[] = [7, 30, 90];

export type TrendStatus = 'ok' | 'no-history' | 'stale' | 'short-history' | 'too-few-sales';

export interface TrendPoint {
  d: string;
  u: number;
  r?: number | null;
  gap?: number;
}

/** One product's trend, as served by /api/product-trends. */
export interface ProductTrend {
  status: TrendStatus;
  asOf: string | null;
  historyDays: number;
  units: number | null;
  priorUnits: number | null;
  /** fraction; 0.5 is +50%. null unless status is 'ok' */
  growth: number | null;
  points: TrendPoint[];
}

export interface TrendsResponse {
  tier: 'free' | 'paid';
  trends: Record<string, ProductTrend>;
  /** products whose history could not be read: not the same as "no history" */
  unreadable?: number;
}

const cache = new Map<string, { at: number; data: TrendsResponse }>();
const TTL = 10 * 60 * 1000;

export async function fetchTrends(
  ids: string[],
  range: TrendRange,
  detail = false,
): Promise<TrendsResponse> {
  const key = `${range}:${detail}:${ids.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const params = new URLSearchParams({ ids: ids.join(','), range: String(range) });
  if (detail) params.set('detail', '1');
  const res = await fetch(`/api/product-trends?${params}`, { headers: await authHeader() });
  if (!res.ok) throw new Error('Failed to fetch trends');
  const data = (await res.json()) as TrendsResponse;
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** "+84%" / "-12%". Above 999% it is capped in the label, not in the data. */
export function formatGrowth(g: number): string {
  const p = Math.round(g * 100);
  if (p > 999) return '+999%+';
  return `${p > 0 ? '+' : ''}${p}%`;
}

/** Why a growth figure is absent. Shown in a tooltip beside the em dash. */
export function trendReason(t: ProductTrend | undefined, range: TrendRange): string {
  if (!t) return 'No trend figure for this product.';
  switch (t.status) {
    case 'ok':
      return `${t.units?.toLocaleString()} units in the last ${range} days vs ${t.priorUnits?.toLocaleString()} in the ${range} days before.`;
    case 'no-history':
      return 'We have no daily sales snapshots for this product yet, so there is no trend. This is not zero growth.';
    case 'stale':
      return 'This product has not been snapshotted recently, so any trend would be out of date.';
    case 'short-history':
      return `We hold ${t.historyDays} days of sales history for this product; a ${range}-day comparison needs ${range * 2}.`;
    case 'too-few-sales':
      return `Fewer than 10 units sold in the earlier ${range} days, so a percentage would be noise.`;
  }
}
