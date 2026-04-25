// Server-side product ranking endpoint. Pre-computes product metrics
// (revenue estimates, period views, units sold) that were previously
// computed in the browser after fetching all products + videos + snapshots.
//
// Caches results for 1 hour. Returns paginated, pre-sorted results.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

interface CachedResult {
  products: any[];
  timestamp: number;
}

const cache = new Map<string, CachedResult>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getVideoPostDate(videoUrl: string): Date | null {
  const match = videoUrl?.match(/video\/(\d+)/);
  if (!match) return null;
  try {
    const ts = Number(BigInt(match[1]) >> 32n);
    const date = new Date(ts * 1000);
    if (date.getFullYear() < 2020 || date.getFullYear() > 2027) return null;
    return date;
  } catch {
    return null;
  }
}

function getDateFromSnowflake(id: string): Date | null {
  try {
    const ts = Number(BigInt(id) >> 32n);
    const date = new Date(ts * 1000);
    if (date.getFullYear() < 2020 || date.getFullYear() > 2027) return null;
    return date;
  } catch {
    return null;
  }
}

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
  return delta;
}

function estimateProductMetrics(
  product: any,
  videos: any[],
  periodDays: number,
  categoryMedianPrice: number,
  snapshots: any[],
) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - periodDays * 86400000);
  const listingDate = getDateFromSnowflake(product.product_id);
  const daysActive = listingDate
    ? Math.max(
        1,
        Math.floor((now.getTime() - listingDate.getTime()) / 86400000),
      )
    : 365;

  let periodViews = 0;
  let periodVideoCount = 0;
  let totalViews = 0;

  for (const v of videos) {
    const views = v.view_count || 0;
    totalViews += views;
    const postDate = getVideoPostDate(v.video_url);
    if (postDate && postDate >= cutoff) {
      periodViews += views;
      periodVideoCount++;
    }
  }

  const soldCount = product.sold_count || 0;
  const price = product.sale_price || 0;
  const effectivePrice = price > 0 ? price : categoryMedianPrice;
  const hasRealPrice = price > 0;

  let estPeriodUnitsSold: number;
  let hasRealDelta = false;

  if (periodViews === 0) {
    estPeriodUnitsSold = 0;
  } else {
    const exactDelta = calculateSnapshotDelta(snapshots, periodDays);
    if (exactDelta != null && exactDelta >= 0) {
      estPeriodUnitsSold = exactDelta;
      hasRealDelta = true;
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

async function computeTopProducts(
  nicheSlug: string,
  days: number,
): Promise<any[]> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Fetch products with sales
  let products: any[] = [];
  if (nicheSlug === 'all') {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, stock_quantity, product_url')
        .gt('sold_count', 0)
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
        .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, stock_quantity, product_url')
        .eq('niche_slug', nicheSlug)
        .gt('sold_count', 0)
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

  for (let i = 0; i < pids.length; i += 200) {
    const batch = pids.slice(i, i + 200);

    const { data: vids } = await supabase
      .from('product_videos')
      .select('product_id, video_url, view_count, cover_image_url')
      .in('product_id', batch)
      .order('view_count', { ascending: false })
      .limit(5000);
    if (vids) {
      for (const v of vids) {
        if (!videoMap[v.product_id]) videoMap[v.product_id] = [];
        videoMap[v.product_id].push(v);
      }
    }

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

  const enriched = products.map((p) => {
    const videos = videoMap[p.product_id] || [];
    const snapshots = snapMap[p.product_id] || [];
    const metrics = estimateProductMetrics(p, videos, days, medianPrice, snapshots);
    // Get top 5 video thumbnails — fall back to product image if video has no cover
    const topVideos = videos.slice(0, 5).map((v: any) => ({
      video_url: v.video_url,
      view_count: v.view_count,
      cover_image_url: v.cover_image_url || p.image_url || null,
    }));
    return { ...p, metrics, topVideos };
  });

  // 4. Sort by estimated revenue (default)
  enriched.sort(
    (a: any, b: any) => (b.metrics.estRevenue || 0) - (a.metrics.estRevenue || 0),
  );

  return enriched;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  try {
    const nicheSlug = (req.query.niche as string) || 'all';
    const days = parseInt((req.query.days as string) || '7', 10);
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const sortBy = (req.query.sort as string) || 'estRevenue';
    const sortDir = (req.query.dir as string) || 'desc';

    if (![7, 14, 30, 90, 180, 365].includes(days)) {
      return res.status(400).json({ error: 'Invalid days' });
    }

    const cacheKey = `${nicheSlug}:${days}`;
    const cached = cache.get(cacheKey);
    let products: any[];

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      products = cached.products;
    } else {
      products = await computeTopProducts(nicheSlug, days);
      cache.set(cacheKey, { products, timestamp: Date.now() });
    }

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
          case 'sale_price': aVal = a.sale_price || 0; bVal = b.sale_price || 0; break;
          default: aVal = 0; bVal = 0;
        }
        return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
      });
    }

    const offset = (page - 1) * limit;
    res.setHeader(
      'Cache-Control',
      's-maxage=3600, stale-while-revalidate=86400, max-age=300',
    );

    return res.json({
      products: sorted.slice(offset, offset + limit),
      total: sorted.length,
      page,
      limit,
    });
  } catch (err: any) {
    console.error('top-products error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
}
