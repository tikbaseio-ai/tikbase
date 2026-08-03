// Server-side product ranking endpoint. Pre-computes product metrics
// (revenue estimates, period views, units sold) that were previously
// computed in the browser after fetching all products + videos + snapshots.
//
// View arithmetic is done in SQL (product_view_stats). It used to be done in JS
// over a video read that PostgREST silently truncated to 1000 rows per batch —
// see the 2026-08-03 migration for the measured damage. getVideoPostDate, the
// snowflake decoder that windowed those rows, went with it: post_ts on
// product_videos is now the single definition of when a video was posted.
//
// Caches results for 1 hour. Returns paginated, pre-sorted results.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface CachedResult {
  products: any[];
  timestamp: number;
}

const cache = new Map<string, CachedResult>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// How deep the opportunity thresholds are derived from. Matches
// STORE_TOP_N_PRODUCTS in pipeline/precompute-rankings.ts — the rows that
// actually reach a payload — so the cached and live-computed paths agree.
export const OPPORTUNITY_POOL = 400;

// Products per product_view_stats / product_top_videos call. The top-videos RPC
// returns up to 5 rows per product, so 150 x 5 = 750 stays under PostgREST's
// 1000-row response cap — the very cap this replaced.
const VIEW_STATS_CHUNK = 150;


// Days since we first saw this product in our data. TikTok Shop product IDs are
// NOT snowflake-timestamped like video IDs — decoding product_id as a snowflake
// always fell outside the valid range, so the old code silently defaulted
// daysActive to 365 for every single product. Use the real first-seen instead:
// products.created_at, or the earliest snapshot if created_at is missing.
function firstSeenDaysActive(product: any, snapshots: any[], now: Date): number {
  const signals: number[] = [];
  if (product?.created_at) {
    const t = Date.parse(product.created_at);
    if (!Number.isNaN(t)) signals.push(t);
  }
  if (snapshots?.length) {
    const earliest = [...snapshots].sort((a, b) =>
      a.snapshot_date.localeCompare(b.snapshot_date),
    )[0]?.snapshot_date;
    if (earliest) {
      const t = Date.parse(earliest);
      if (!Number.isNaN(t)) signals.push(t);
    }
  }
  if (!signals.length) return 365; // no signal at all — keep the old default
  return Math.max(1, Math.floor((now.getTime() - Math.min(...signals)) / 86400000));
}

// A snapshot delta is only trusted if its true span is within this multiple
// of the requested window; beyond it we fall through to the estimator.
const MAX_SPAN_RATIO = 1.5;

function calculateSnapshotDelta(
  snapshots: any[],
  periodDays: number,
): number | null {
  if (!snapshots || snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );
  const latest = sorted[sorted.length - 1];
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - periodDays);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  let baseline = sorted[0];
  for (const s of sorted) {
    if (s.snapshot_date <= cutoffStr) baseline = s;
    else break;
  }
  if (baseline.snapshot_date > cutoffStr) return null;
  if (baseline.snapshot_date >= latest.snapshot_date) return null;

  const delta = Math.max(
    0,
    (latest.sold_count || 0) - (baseline.sold_count || 0),
  );
  const lifetime = latest.sold_count || 0;
  if (delta > lifetime) return null;
  if (periodDays <= 14 && delta > lifetime * 0.5 && lifetime > 10000)
    return null;

  // The delta spans baseline -> latest, which is NOT necessarily periodDays:
  // a missing snapshot at the cutoff pushes the baseline older, silently
  // measuring more days than the window claims (the 07-19/07-20 gap does this
  // on specific dates). Normalize to the labelled window; if the span is way
  // off, the reading isn't representative — reject it and let the estimator
  // handle the product instead of reporting an inflated "real" delta.
  const spanDays =
    (Date.parse(latest.snapshot_date) - Date.parse(baseline.snapshot_date)) / 86400000;
  if (!(spanDays > 0)) return null;
  if (spanDays > periodDays * MAX_SPAN_RATIO) return null;
  // Symmetric lower bound: a span much SHORTER than the window means the window
  // is incomplete (a stale `latest` — e.g. snapshots stopped during an outage).
  // Normalizing would scale the partial delta UP and extrapolate from data we
  // don't have, so reject and let the estimator handle it instead.
  if (spanDays < periodDays / MAX_SPAN_RATIO) return null;

  return Math.round(delta * (periodDays / spanDays));
}

interface ViewStats {
  periodViews: number;
  periodVideoCount: number;
  totalViews: number;
  videoCount: number;
}

function estimateProductMetrics(
  product: any,
  videos: any[],
  periodDays: number,
  categoryMedianPrice: number,
  snapshots: any[],
  stats: ViewStats | undefined,
) {
  const now = new Date();
  const daysActive = firstSeenDaysActive(product, snapshots, now);

  // Summed in SQL over EVERY video row. Previously summed in JS over whatever
  // survived PostgREST's 1000-row response cap, which on the top batch meant
  // 2.4% of the rows. `videos` is now just the top 5 thumbnails and must never
  // be used for arithmetic again.
  const periodViews = stats?.periodViews ?? 0;
  const periodVideoCount = stats?.periodVideoCount ?? 0;
  const totalViews = stats?.totalViews ?? 0;

  // sold_count: the products-table row can lag the fresh daily snapshot; since
  // sold_count is cumulative (monotonic), take the higher of the two. Feeds the
  // maxFraction caps and the displayed lifetime-sold — same snapshot-fallback
  // idea as the price fallback below.
  const soldCount = (() => {
    const base = product.sold_count || 0;
    if (!snapshots?.length) return base;
    const latest = [...snapshots].sort((a, b) =>
      a.snapshot_date.localeCompare(b.snapshot_date)).at(-1);
    return Math.max(base, latest?.sold_count ?? 0);
  })();
  // Price: prefer products.sale_price, then fall back to the freshest snapshot's
  // sale_price (Phase 3 writes it daily, and the snapshots are already loaded
  // here), and only then the category median. A snapshot price is a real fetched
  // price — just stored in a different table — so hasRealPrice is true for it too.
  const latestSnapPrice = (() => {
    if (!snapshots?.length) return null;
    const latest = [...snapshots].sort((a, b) =>
      a.snapshot_date.localeCompare(b.snapshot_date)).at(-1);
    const sp = latest?.sale_price ?? 0;
    return sp > 0 ? sp : null;
  })();
  const price = product.sale_price > 0 ? product.sale_price : (latestSnapPrice ?? 0);
  const effectivePrice = price > 0 ? price : categoryMedianPrice;
  const hasRealPrice = price > 0;

  let estPeriodUnitsSold: number;
  let hasRealDelta = false;

  // Prefer real day-over-day sales from snapshots FIRST — a product can be a
  // top seller in the window without a fresh viral video, so this is checked
  // regardless of recent video activity. (Previously periodViews === 0
  // short-circuited to 0 units and hid genuine best-sellers from the ranking.)
  const exactDelta = calculateSnapshotDelta(snapshots, periodDays);
  if (exactDelta != null && exactDelta >= 0) {
    estPeriodUnitsSold = exactDelta;
    hasRealDelta = true;
  } else if (periodViews === 0) {
    // No measured sales delta and no recent attention → nothing to estimate.
    estPeriodUnitsSold = 0;
  } else {
    let scaledFromShorter: number | null = null;
    if (snapshots && snapshots.length >= 2) {
      for (const shorter of [180, 90, 30, 14, 7].filter(
        (d) => d < periodDays,
      )) {
        const sd = calculateSnapshotDelta(snapshots, shorter);
        if (sd != null && sd > 0) {
          scaledFromShorter = Math.min(
            Math.round(sd * (periodDays / shorter)),
            soldCount,
          );
          break;
        }
      }
    }

    // Conversion rate estimation
    let impliedRate =
      totalViews > 10000 && soldCount > 10
        ? Math.max(0.0005, Math.min(0.08, soldCount / totalViews))
        : periodViews > 10000000
          ? 0.0008
          : periodViews > 1000000
            ? 0.0015
            : periodViews > 100000
              ? 0.003
              : periodViews > 10000
                ? 0.005
                : 0.008;

    const recency =
      periodDays <= 7
        ? 1.5
        : periodDays <= 14
          ? 1.3
          : periodDays <= 30
            ? 1.15
            : 1.0;

    let velocityEstimate = Math.round(periodViews * impliedRate * recency);
    const expectedRatio = Math.min(1, periodDays / 365);
    const velocityRatio =
      totalViews > 0 ? periodViews / totalViews : 0;
    const momentum = Math.min(5, velocityRatio / expectedRatio);
    if (momentum > 1) {
      velocityEstimate = Math.round(
        velocityEstimate * Math.min(momentum, 2.5),
      );
    }

    const maxFraction =
      periodDays <= 7
        ? 0.15
        : periodDays <= 14
          ? 0.25
          : periodDays <= 30
            ? 0.4
            : periodDays <= 90
              ? 0.65
              : 0.85;
    velocityEstimate = Math.min(
      velocityEstimate,
      Math.round(soldCount * maxFraction),
    );

    let simpleVelocity =
      totalViews > 0
        ? Math.round(soldCount * (periodViews / totalViews) * recency)
        : 0;
    simpleVelocity = Math.min(
      simpleVelocity,
      Math.round(soldCount * maxFraction),
    );

    estPeriodUnitsSold = Math.max(
      scaledFromShorter || 0,
      velocityEstimate,
      simpleVelocity,
    );

    if (estPeriodUnitsSold === 0 && soldCount > 0 && periodViews > 0) {
      estPeriodUnitsSold = Math.max(
        1,
        Math.round(
          soldCount * (periodDays / Math.max(daysActive, periodDays)) * 0.5,
        ),
      );
    }
  }

  return {
    periodViews,
    periodVideoCount,
    totalViews,
    estPeriodUnitsSold,
    estRevenue: estPeriodUnitsSold * effectivePrice,
    hasRealPrice,
    hasRealDelta,
    daysActive,
    velocityRatio: totalViews > 0 ? periodViews / totalViews : 0,
  };
}

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---- Per-window creator metrics -----------------------------------------
//
// One set-based aggregate over product_videos per WINDOW (product_window_stats,
// see migrations/manual/2026-07-30-product-window-stats.sql), memoised here so
// the 15-niche loop in precompute-rankings reuses a single query instead of
// re-running it 15 times. Measured ~9s per window, so a full 6-window run adds
// about a minute to an ~85-minute job.

export interface WindowStat {
  distinctCreators: number;
  windowVideos: number;
  commissionedVideos: number;
}

const windowStatsCache = new Map<number, { stats: Map<string, WindowStat>; timestamp: number }>();

// Products per RPC call. Sized empirically: at 2000 the widest window (365d)
// still lost a chunk to the statement timeout, so it is 500 — every chunk then
// completes, at the cost of more round trips. See the migration for the
// whole-window costs that make chunking mandatory rather than optional.
const WINDOW_STATS_CHUNK = 500;

/**
 * Every product id, keyset-paginated and memoised across windows.
 *
 * Keyset because PostgREST caps a response at 1000 rows regardless of .limit()
 * — a naive single read silently sees 1/47th of the catalogue. Memoised because
 * the six windows would otherwise each re-walk the same 48 pages.
 */
let productIdsMemo: { ids: string[]; timestamp: number } | null = null;

async function loadAllProductIds(supabase: SupabaseClient): Promise<string[]> {
  if (productIdsMemo && Date.now() - productIdsMemo.timestamp < CACHE_TTL) {
    return productIdsMemo.ids;
  }
  const ids: string[] = [];
  let last = '';
  for (;;) {
    let q = supabase
      .from('products')
      .select('product_id')
      .order('product_id', { ascending: true })
      .limit(1000);
    if (last) q = q.gt('product_id', last);
    const { data, error } = await q;
    if (error) {
      console.warn(`  [WARN] product id scan failed: ${error.message}`);
      return ids;
    }
    if (!data || data.length === 0) break;
    for (const r of data as any[]) ids.push(String(r.product_id));
    last = ids[ids.length - 1];
    if (data.length < 1000) break;
  }
  productIdsMemo = { ids, timestamp: Date.now() };
  return ids;
}

export async function loadWindowStats(days: number): Promise<Map<string, WindowStat>> {
  const cached = windowStatsCache.get(days);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.stats;

  const supabase = getAdminClient();
  const stats = new Map<string, WindowStat>();

  const ids = await loadAllProductIds(supabase);
  if (ids.length === 0) return stats;

  for (let i = 0; i < ids.length; i += WINDOW_STATS_CHUNK) {
    const chunk = ids.slice(i, i + WINDOW_STATS_CHUNK);
    const { data, error } = await supabase.rpc('product_window_stats', {
      p_days: days,
      p_product_ids: chunk,
    });
    if (error) {
      // Non-fatal: the ranking is still correct without the creator columns, and
      // failing a whole precompute over an enrichment would be a bad trade. The
      // affected products report null and the UI renders an em dash.
      console.warn(
        `  [WARN] product_window_stats(${days}) chunk ${i / WINDOW_STATS_CHUNK} failed: ${error.message}`,
      );
      continue;
    }
    for (const r of (data as any[]) || []) {
      stats.set(String(r.product_id), {
        distinctCreators: Number(r.distinct_creators) || 0,
        windowVideos: Number(r.window_videos) || 0,
        commissionedVideos: Number(r.commissioned_videos) || 0,
      });
    }
  }

  windowStatsCache.set(days, { stats, timestamp: Date.now() });
  return stats;
}

/**
 * Opportunity badge: proven demand, little competition.
 *
 *   hasRealDelta            — MEASURED sales, never a modelled estimate
 *   AND revenue >= p75      — top quartile of this payload's window revenue
 *   AND creators <= median  — fewer creators than half this payload
 *
 * The thresholds are derived from the payload being built, not hardcoded, so
 * "top quartile" means top quartile of what the user is actually looking at.
 * They are computed over the stored top-N rather than the full ranked list on
 * purpose: the full list is tens of thousands of products, most with no revenue
 * at all, which would make "top quartile" a meaningless bar.
 *
 * hasRealDelta is a hard gate. A badge that fires on modelled revenue would be
 * pointing users at a number the estimator invented.
 */
export function annotateOpportunity(rows: any[]): {
  revenueP75: number;
  creatorMedian: number;
  badged: number;
} {
  const revenues = rows
    .map((r) => Number(r?.metrics?.estRevenue) || 0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const creators = rows
    .map((r) => (r?.distinct_creators == null ? null : Number(r.distinct_creators)))
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  const revenueP75 = revenues.length
    ? revenues[Math.min(revenues.length - 1, Math.floor(revenues.length * 0.75))]
    : Infinity;
  const creatorMedian = creators.length
    ? creators[Math.floor(creators.length / 2)]
    : 0;

  let badged = 0;
  for (const r of rows) {
    const rev = Number(r?.metrics?.estRevenue) || 0;
    const dc = r?.distinct_creators;
    const isOpp =
      r?.metrics?.hasRealDelta === true &&
      rev >= revenueP75 &&
      dc != null &&
      dc <= creatorMedian;
    r.opportunity = isOpp;
    if (isOpp) badged++;
  }
  return { revenueP75, creatorMedian, badged };
}

// Read the daily precomputed ranking (top-N enriched products) written by
// pipeline/precompute-rankings.ts. Returns null if the table/row isn't there
// yet, so the handler transparently falls back to live computation.
async function readPrecomputed(nicheSlug: string, days: number): Promise<any[] | null> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('rankings_cache')
      .select('payload')
      .eq('cache_key', `products:${nicheSlug}:${days}`)
      .maybeSingle();
    if (error || !data || !Array.isArray((data as any).payload)) return null;
    return (data as any).payload as any[];
  } catch {
    return null;
  }
}

export async function computeTopProducts(
  nicheSlug: string,
  days: number,
): Promise<any[]> {
  const supabase = getAdminClient();

  // 1. Fetch products with sales.
  // price_unavailable is set by the pipeline when a product 404s at TikTok —
  // it is gone upstream, so ranking it serves a dead listing and keeps it in
  // rankings_cache, where the snapshot membership monitor then counts it as a
  // served product that never refreshes (it is excluded from fetching for the
  // same reason). Excluding it here drops those rows out of the cache on the
  // next nightly precompute. Measured 2026-07-27: 45 such products were being
  // served.
  let products: any[] = [];
  if (nicheSlug === 'all') {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, stock_quantity, product_url, created_at, seller_name')
        .gt('sold_count', 0)
        .not('price_unavailable', 'is', true)
        .order('sold_count', { ascending: false })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      products = products.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  } else {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, stock_quantity, product_url, created_at, seller_name')
        .eq('niche_slug', nicheSlug)
        .gt('sold_count', 0)
        .not('price_unavailable', 'is', true)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      products = products.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // 2. Fetch videos + snapshots for these products
  const pids = products.map((p) => p.product_id);
  const videoMap: Record<string, any[]> = {};
  const snapMap: Record<string, any[]> = {};

  // View stats come from SQL, not from reading every video row.
  //
  // The old read asked for 5000 video rows per 200-product batch and PostgREST
  // returned 1000, silently. Measured on the top-200 batch of 'all': 41,342 rows
  // exist, 1,000 came back (97.6% dropped), 25 products were invisible entirely
  // and reported totalViews 0, and one real 141,205,644-view product looked
  // empty. It skewed hardest on the highest-ranked products, because the batch
  // is ordered by sold_count and the biggest sellers carry the most videos.
  //
  // Aggregating server-side returns one row per product instead of one per
  // video, so there is nothing to truncate. Thumbnails come from a second RPC
  // that gives each product its own top N rather than the batch's top N.
  const viewStats = new Map<string, {
    periodViews: number; periodVideoCount: number; totalViews: number; videoCount: number;
  }>();

  for (let i = 0; i < pids.length; i += VIEW_STATS_CHUNK) {
    const batch = pids.slice(i, i + VIEW_STATS_CHUNK);
    const { data: stats, error: statsErr } = await supabase.rpc('product_view_stats', {
      p_days: days,
      p_product_ids: batch,
    });
    if (statsErr) {
      console.warn(`  [WARN] product_view_stats chunk failed: ${statsErr.message}`);
    } else {
      for (const r of (stats as any[]) || []) {
        viewStats.set(String(r.product_id), {
          periodViews: Number(r.period_views) || 0,
          periodVideoCount: Number(r.period_video_count) || 0,
          totalViews: Number(r.total_views) || 0,
          videoCount: Number(r.video_count) || 0,
        });
      }
    }

    const { data: tops, error: topsErr } = await supabase.rpc('product_top_videos', {
      p_product_ids: batch,
      p_limit: 5,
    });
    if (topsErr) {
      console.warn(`  [WARN] product_top_videos chunk failed: ${topsErr.message}`);
    } else {
      for (const v of (tops as any[]) || []) {
        if (!videoMap[v.product_id]) videoMap[v.product_id] = [];
        videoMap[v.product_id].push(v);
      }
    }
  }

  for (let i = 0; i < pids.length; i += 200) {
    const batch = pids.slice(i, i + 200);

    const { data: snaps } = await supabase
      .from('product_snapshots')
      .select('product_id, sold_count, sale_price, snapshot_date')
      .in('product_id', batch)
      .order('snapshot_date', { ascending: true })
      .limit(10000);
    if (snaps) {
      for (const s of snaps) {
        if (!snapMap[s.product_id]) snapMap[s.product_id] = [];
        snapMap[s.product_id].push(s);
      }
    }
  }

  // 3. Compute metrics
  const withPrice = products.filter((p) => p.sale_price > 0).map((p) => p.sale_price).sort((a: number, b: number) => a - b);
  const medianPrice = withPrice.length > 0 ? withPrice[Math.floor(withPrice.length / 2)] : 24.99;

  // Per-window creator competition, one aggregate for the whole table.
  const windowStats = await loadWindowStats(days);

  const enriched = products.map((p) => {
    const videos = videoMap[p.product_id] || [];
    const snapshots = snapMap[p.product_id] || [];
    const metrics = estimateProductMetrics(
      p, videos, days, medianPrice, snapshots, viewStats.get(String(p.product_id)),
    );
    // Get top 5 video thumbnails — fall back to product image if video has no cover
    const topVideos = videos.slice(0, 5).map((v: any) => ({
      video_url: v.video_url,
      view_count: v.view_count,
      cover_image_url: v.cover_image_url || p.image_url || null,
    }));

    const ws = windowStats.get(String(p.product_id));
    // A product with no videos in the window has no intensity to report. null,
    // never 0 — "nobody posted" and "nobody was paid" are different claims, and
    // 0% would assert the second one.
    const affiliateIntensity =
      ws && ws.windowVideos > 0
        ? Math.round((ws.commissionedVideos / ws.windowVideos) * 1000) / 1000
        : null;

    return {
      ...p,
      metrics,
      topVideos,
      distinct_creators: ws?.distinctCreators ?? 0,
      window_video_count: ws?.windowVideos ?? 0,
      affiliate_intensity: affiliateIntensity,
    };
  });

  // 4. Sort by estimated revenue (default)
  enriched.sort(
    (a: any, b: any) => (b.metrics.estRevenue || 0) - (a.metrics.estRevenue || 0),
  );

  // 5. Opportunity badge, over the slice that actually gets stored and shown —
  //    see annotateOpportunity for why the thresholds come from the payload
  //    rather than the full ranked list.
  const pool = enriched.slice(0, OPPORTUNITY_POOL);
  const thresholds = annotateOpportunity(pool);
  for (const r of enriched.slice(OPPORTUNITY_POOL)) r.opportunity = false;
  console.log(
    `    opportunity ${nicheSlug}:${days} — revenue p75 ` +
    // An empty payload has no p75; Infinity is correct arithmetic and useless
    // output, and a new niche logs it every night until discovery fills in.
    `${Number.isFinite(thresholds.revenueP75) ? '$' + thresholds.revenueP75.toFixed(0) : 'n/a'}, ` +
    `creator median ${thresholds.creatorMedian}, ${thresholds.badged}/${pool.length} badged`,
  );

  return enriched;
}

// Server-side entitlement gate. The full Pro dataset used to be publicly
// curlable — all gating was client-side. Resolve the caller's tier from their
// Bearer token here (lightweight verification copied from check-subscription.ts;
// NO Stripe calls on the data path). Any missing/invalid token or lookup failure
// degrades to 'free' — we never 401 a data request.
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
async function resolveTier(req: VercelRequest): Promise<'free' | 'paid'> {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return 'free';
    const supabase = getAdminClient();
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) return 'free';
    const { data, error } = await supabase.auth.admin.getUserById(authData.user.id);
    if (error || !data.user) return 'free';
    const sub = (data.user.app_metadata as any)?.subscription;
    return sub?.status && ACTIVE_STATUSES.has(sub.status) ? 'paid' : 'free';
  } catch {
    return 'free';
  }
}

// Free tier: real top 10 on fresh 7-day data, 'all' niche only.
const FREE_NICHE = 'all';
const FREE_DAYS = 7;
const FREE_ROWS = 10;

// Windows always shown as columns, regardless of which one is ranking.
const COMPANION_WINDOWS = [7, 30];

interface WindowRevenue {
  revenue: number;
  unitsSold: number;
  hasRealDelta: boolean;
  hasRealPrice: boolean;
}

/**
 * Attach every companion window's revenue to each row, keyed by product_id.
 *
 * Reads the sibling payloads straight from rankings_cache (not a recompute):
 * each is an instant table read and they are already in memory for the common
 * case. The ranking window's own numbers are reused rather than re-read.
 */
async function withCompanionWindows(
  nicheSlug: string,
  rankingDays: number,
  rows: any[],
): Promise<any[]> {
  const wanted = Array.from(new Set([...COMPANION_WINDOWS, rankingDays]));
  const byWindow = new Map<number, Map<string, WindowRevenue>>();

  for (const d of wanted) {
    if (d === rankingDays) continue; // taken from `rows` below
    let payload: any[] | null = null;
    const sibling = cache.get(`${nicheSlug}:${d}`);
    if (sibling && Date.now() - sibling.timestamp < CACHE_TTL) {
      payload = sibling.products;
    } else {
      payload = await readPrecomputed(nicheSlug, d);
      if (payload) cache.set(`${nicheSlug}:${d}`, { products: payload, timestamp: Date.now() });
    }
    if (!payload) continue; // window not precomputed yet -> stays null

    const m = new Map<string, WindowRevenue>();
    for (const p of payload) {
      m.set(String(p.product_id), {
        revenue: Number(p?.metrics?.estRevenue) || 0,
        unitsSold: Number(p?.metrics?.estPeriodUnitsSold) || 0,
        hasRealDelta: p?.metrics?.hasRealDelta === true,
        hasRealPrice: p?.metrics?.hasRealPrice === true,
      });
    }
    byWindow.set(d, m);
  }

  return rows.map((r) => {
    const windows: Record<string, WindowRevenue | null> = {};
    for (const d of wanted) {
      if (d === rankingDays) {
        windows[String(d)] = {
          revenue: Number(r?.metrics?.estRevenue) || 0,
          unitsSold: Number(r?.metrics?.estPeriodUnitsSold) || 0,
          hasRealDelta: r?.metrics?.hasRealDelta === true,
          hasRealPrice: r?.metrics?.hasRealPrice === true,
        };
      } else {
        windows[String(d)] = byWindow.get(d)?.get(String(r.product_id)) ?? null;
      }
    }
    return { ...r, windows };
  });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const tier = await resolveTier(req);

    let nicheSlug = (req.query.niche as string) || 'all';
    let days = parseInt((req.query.days as string) || '7', 10);
    let page = Math.max(1, parseInt((req.query.page as string) || '1', 10) || 1);
    let limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50));
    const sortBy = (req.query.sort as string) || 'estRevenue';
    const sortDir = (req.query.dir as string) || 'desc';

    // Free-tier coercion BEFORE cache/compute lookup: pin to all/7d/top-10 no
    // matter what the client asks for (blocks ?niche=&days=&page=&limit= bypass).
    if (tier === 'free') {
      nicheSlug = FREE_NICHE;
      days = FREE_DAYS;
      page = 1;
      limit = FREE_ROWS;
    }

    if (![7, 14, 30, 90, 180, 365].includes(days)) {
      return res.status(400).json({ error: 'Invalid days' });
    }

    const cacheKey = `${nicheSlug}:${days}`;
    const cached = cache.get(cacheKey);
    let products: any[];

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      products = cached.products;
    } else {
      // Prefer the daily precomputed ranking (instant read). Fall back to live
      // computation only if this niche/timeframe hasn't been precomputed yet.
      const pre = await readPrecomputed(nicheSlug, days);
      products = pre ?? (await computeTopProducts(nicheSlug, days));
      cache.set(cacheKey, { products, timestamp: Date.now() });
    }

    // Dual-window merge. The table shows 7d AND 30d revenue side by side
    // whatever the ranking window is, so both payloads are read and joined on
    // product_id here rather than making the client fire a second request and
    // stitch it.
    //
    // A product ranked in one window and absent from the other keeps null for
    // the missing side — the UI renders an em dash. Zero would claim the
    // product sold nothing that window, which is a different and false claim:
    // absence from a top-400 payload means "not ranked", not "no sales".
    products = await withCompanionWindows(nicheSlug, days, products);

    // Re-sort if requested sort differs from default
    let sorted = products;
    if (sortBy !== 'estRevenue' || sortDir !== 'desc') {
      sorted = [...products].sort((a, b) => {
        let aVal: number, bVal: number;
        switch (sortBy) {
          case 'periodViews': aVal = a.metrics.periodViews; bVal = b.metrics.periodViews; break;
          case 'sold_count': aVal = a.metrics.estPeriodUnitsSold; bVal = b.metrics.estPeriodUnitsSold; break;
          case 'estRevenue': aVal = a.metrics.estRevenue; bVal = b.metrics.estRevenue; break;
          case 'stock_quantity': aVal = a.stock_quantity || 0; bVal = b.stock_quantity || 0; break;
          // Lifetime units, distinct from 'sold_count' above which is the
          // window's estimated units.
          case 'total_sold': aVal = a.sold_count || 0; bVal = b.sold_count || 0; break;
          case 'sale_price': aVal = a.sale_price || 0; bVal = b.sale_price || 0; break;
          // New sortable columns. A null window sorts as -1 so "not ranked in
          // this window" lands below a genuine $0 rather than above it.
          case 'revenue7d': aVal = a.windows?.['7']?.revenue ?? -1; bVal = b.windows?.['7']?.revenue ?? -1; break;
          case 'revenue30d': aVal = a.windows?.['30']?.revenue ?? -1; bVal = b.windows?.['30']?.revenue ?? -1; break;
          case 'distinct_creators': aVal = a.distinct_creators ?? -1; bVal = b.distinct_creators ?? -1; break;
          case 'affiliate_intensity': aVal = a.affiliate_intensity ?? -1; bVal = b.affiliate_intensity ?? -1; break;
          default: aVal = 0; bVal = 0;
        }
        return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
      });
    }

    const offset = (page - 1) * limit;
    // Per-user (tiered) responses must never be shared by the CDN, which caches
    // by URL and ignores auth — an edge-cached Pro payload would leak to free
    // callers. 'private' keeps it browser-only; rankings_cache keeps it fast.
    res.setHeader('Cache-Control', 'private, max-age=300');

    return res.json({
      products: sorted.slice(offset, offset + limit),
      total: sorted.length, // honest full count even when the page is truncated
      page,
      limit,
    });
  } catch (err: any) {
    console.error('top-products error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
}
