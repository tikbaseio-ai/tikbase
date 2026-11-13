// Shared by /api/product-views (the preset tabs) and /api/export-products (CSV):
// both must hand the user the same rows, so there is exactly one place that
// reads the stored rankings and applies a preset.
//
// Reads rankings_cache only. It never recomputes a ranking and never calls
// ScrapeCreators - see CLAUDE.md on why the nightly precompute owns that.
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadTrends } from './trend-store.js';
import { applyPreset, type PresetId, type PoolRow } from './presets.js';
import type { Trend, TrendRange } from './trend-math.js';

/** The stored payload each preset is drawn from. Fixed at 30 days so the
 *  revenue, creator and intensity columns all describe the same window. */
export const PRESET_WINDOW = 30;

export async function readPayload(
  supabase: SupabaseClient,
  niche: string,
  days: number,
): Promise<any[] | null> {
  const { data, error } = await supabase
    .from('rankings_cache')
    .select('payload')
    .eq('cache_key', `products:${niche}:${days}`)
    .maybeSingle();
  if (error || !data || !Array.isArray((data as any).payload)) return null;
  return (data as any).payload as any[];
}

interface WindowRevenue {
  revenue: number;
  unitsSold: number;
  hasRealDelta: boolean;
  hasRealPrice: boolean;
}

/** Same `windows` shape /api/top-products attaches, so the table renders either. */
function windowOf(p: any): WindowRevenue {
  return {
    revenue: Number(p?.metrics?.estRevenue) || 0,
    unitsSold: Number(p?.metrics?.estPeriodUnitsSold) || 0,
    hasRealDelta: p?.metrics?.hasRealDelta === true,
    hasRealPrice: p?.metrics?.hasRealPrice === true,
  };
}

export interface ViewRow extends PoolRow {
  windows: Record<string, WindowRevenue | null>;
  trend?: Trend;
}

/** The ranked pool for one niche/window with the 7d and 30d columns attached.
 *  A window the product is not ranked in stays null (an em dash, not $0). */
export async function loadPool(
  supabase: SupabaseClient,
  niche: string,
  days: number,
): Promise<ViewRow[] | null> {
  const main = await readPayload(supabase, niche, days);
  if (!main) return null;
  const wanted = Array.from(new Set([7, 30, days]));
  const byWindow = new Map<number, Map<string, WindowRevenue>>();
  for (const d of wanted) {
    const payload = d === days ? main : await readPayload(supabase, niche, d);
    if (!payload) continue;
    byWindow.set(d, new Map(payload.map((p) => [String(p.product_id), windowOf(p)])));
  }
  return main.map((r) => {
    const windows: Record<string, WindowRevenue | null> = {};
    for (const d of wanted) {
      windows[String(d)] = byWindow.get(d)?.get(String(r.product_id)) ?? null;
    }
    return { ...r, windows } as ViewRow;
  });
}

export interface ViewResult {
  rows: ViewRow[];
  pool: number;
  evaluated: number;
  unevaluated: number;
  criteria: string | null;
  trendFailed: number;
}

/**
 * The rows for a view: a preset (drawn from the 30d payload) or the plain
 * ranking. Trends are attached to every returned row for `range`.
 */
export async function buildView(
  supabase: SupabaseClient,
  opts: { niche: string; days: number; preset: PresetId | null; range: TrendRange },
): Promise<ViewResult | null> {
  const days = opts.preset ? PRESET_WINDOW : opts.days;
  const pool = await loadPool(supabase, opts.niche, days);
  if (!pool) return null;

  if (!opts.preset) {
    const { trends, failed } = await loadTrends(supabase, pool.map((r) => String(r.product_id)), opts.range);
    for (const r of pool) { const t = trends.get(String(r.product_id)); if (t) r.trend = t; }
    return { rows: pool, pool: pool.length, evaluated: pool.length, unevaluated: 0, criteria: null, trendFailed: failed };
  }

  // Growth presets need a trend for every pool row; 'new' does not, but the
  // columns do, and the pool is 400 rows so one pass serves both.
  const { trends, failed } = await loadTrends(supabase, pool.map((r) => String(r.product_id)), opts.range);
  const res = applyPreset(opts.preset, pool, trends, opts.range, Date.now());
  for (const r of res.rows) { const t = trends.get(String(r.product_id)); if (t) r.trend = t; }
  return {
    rows: res.rows, pool: pool.length, evaluated: res.evaluated,
    unevaluated: res.unevaluated, criteria: res.criteria, trendFailed: failed,
  };
}
