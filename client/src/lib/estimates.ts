// Product metrics estimation engine.
// Uses a multi-signal approach to estimate period sales and revenue,
// designed to produce meaningful numbers even without snapshot history.
//
// Signal priority:
//   1. Real snapshot delta (best — actual sold_count difference)
//   2. Scaled shorter delta (if we have real data for a shorter period)
//   3. Video momentum estimate (uses view velocity + engagement signals)

export interface ProductEstimates {
  periodViews: number;        // views from videos posted within this timeframe
  periodVideoCount: number;   // number of videos posted within this timeframe
  totalViews: number;         // lifetime views across all videos
  estPeriodUnitsSold: number; // estimated units sold in this period
  estRevenue: number;         // estimated revenue for the period
  conversionRate: number | null;
  daysActive: number;
  velocityRatio: number;      // what % of total views came from this period
  hasRealPrice: boolean;      // true if product has a real price (not category median)
  hasRealDelta: boolean;      // true if estPeriodUnitsSold came from real snapshots
}

export interface VideoForEstimate {
  video_url: string;
  view_count: number;
}

export interface SnapshotData {
  product_id: string;
  sold_count: number;
  sale_price: number | null;
  snapshot_date: string;
}

// Extract date from TikTok snowflake ID (works for both product_id and video URLs)
export function getDateFromSnowflake(id: string): Date | null {
  try {
    const bigId = BigInt(id);
    const timestamp = Number(bigId >> 32n);
    const date = new Date(timestamp * 1000);
    if (date.getFullYear() < 2020 || date.getFullYear() > 2027) return null;
    return date;
  } catch {
    return null;
  }
}

// Extract video ID from URL, then get its post date
export function getVideoPostDate(videoUrl: string): Date | null {
  const match = videoUrl?.match(/video\/(\d+)/);
  if (!match) return null;
  return getDateFromSnowflake(match[1]);
}

// Calculate snapshot delta for a product over a period
export function calculateSnapshotDelta(
  snapshots: SnapshotData[],
  periodDays: number
): number | null {
  if (!snapshots || snapshots.length < 2) return null;

  const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const latest = sorted[sorted.length - 1];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - periodDays);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  // Find the snapshot closest to (but before) the cutoff
  let baseline = sorted[0]; // fallback to earliest
  for (const s of sorted) {
    if (s.snapshot_date <= cutoffStr) baseline = s;
    else break;
  }

  // Only use delta if the baseline is actually from before the cutoff
  if (baseline.snapshot_date > cutoffStr) return null;
  if (baseline.snapshot_date >= latest.snapshot_date) return null;

  const unitsDelta = Math.max(0, (latest.sold_count || 0) - (baseline.sold_count || 0));

  // Sanity check: delta shouldn't exceed lifetime total
  const lifetimeSold = latest.sold_count || 0;
  if (unitsDelta > lifetimeSold) return null;
  if (periodDays <= 14 && unitsDelta > lifetimeSold * 0.5 && lifetimeSold > 10000) {
    return null; // anomalous data
  }

  return unitsDelta;
}

// ---------------------------------------------------------------------------
// Conversion rate tiers by view count.
// Higher-view products convert at lower rates (broad audience vs targeted).
// These are TikTok Shop averages based on industry data.
// ---------------------------------------------------------------------------
function estimatedConversionRate(totalViews: number, periodViews: number, soldCount: number): number {
  // If we have lifetime data, compute an implied conversion rate
  // and use it as an anchor (capped to reasonable bounds)
  if (totalViews > 10000 && soldCount > 10) {
    const impliedRate = soldCount / totalViews;
    // Clamp to 0.05% – 8% range
    return Math.max(0.0005, Math.min(0.08, impliedRate));
  }

  // Fallback: tiered rates based on view volume
  if (periodViews > 10_000_000) return 0.0008; // mega-viral, low intent
  if (periodViews > 1_000_000)  return 0.0015; // viral
  if (periodViews > 100_000)    return 0.003;   // popular
  if (periodViews > 10_000)     return 0.005;   // moderate
  return 0.008;                                  // niche, high intent
}

// ---------------------------------------------------------------------------
// Recency multiplier: recent periods get a boost because TikTok's algorithm
// front-loads engagement. A video's sales peak in the first 7 days.
// ---------------------------------------------------------------------------
function recencyMultiplier(periodDays: number): number {
  if (periodDays <= 7)  return 1.5;
  if (periodDays <= 14) return 1.3;
  if (periodDays <= 30) return 1.15;
  return 1.0;
}

// ---------------------------------------------------------------------------
// Video momentum score: measures how concentrated views are in the period.
// A product with 80% of views in the last 7 days is surging.
// A product with 5% of views in the last 7 days is stale.
// ---------------------------------------------------------------------------
function momentumScore(periodViews: number, totalViews: number, periodDays: number): number {
  if (totalViews === 0 || periodViews === 0) return 0;

  const velocityRatio = periodViews / totalViews;

  // Expected ratio if views were evenly distributed over 365 days
  const expectedRatio = Math.min(1, periodDays / 365);

  // Momentum = how much faster than average this period is
  // momentum > 1 means accelerating, < 1 means decelerating
  const momentum = velocityRatio / expectedRatio;

  // Cap at 5x to prevent outliers from dominating
  return Math.min(5, momentum);
}

export function calculateProductMetrics(
  product: {
    product_id: string;
    sold_count: number;
    review_count: number;
    sale_price: number;
    niche_slug?: string;
  },
  videos: VideoForEstimate[],
  periodDays: number,
  categoryMedianPrice: number,
  snapshots?: SnapshotData[]
): ProductEstimates {
  const now = new Date();
  const cutoff = new Date(now.getTime() - periodDays * 86400000);

  // Get product listing date
  const listingDate = getDateFromSnowflake(product.product_id);
  const daysActive = listingDate
    ? Math.max(1, Math.floor((now.getTime() - listingDate.getTime()) / 86400000))
    : 365;

  // Sum views by period
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

  const price = product.sale_price || 0;
  const soldCount = product.sold_count || 0;
  const effectivePrice = price > 0 ? price : categoryMedianPrice;
  const hasRealPrice = price > 0;

  // --- Estimate period units sold ---
  let estPeriodUnitsSold: number;
  let hasRealDelta = false;

  if (periodViews === 0) {
    // No video activity this period → no evidence of sales. Hard zero.
    estPeriodUnitsSold = 0;
  } else {
    // === TIER 1: Real snapshot delta ===
    const exactDelta = snapshots ? calculateSnapshotDelta(snapshots, periodDays) : null;

    if (exactDelta != null && exactDelta >= 0) {
      estPeriodUnitsSold = exactDelta;
      hasRealDelta = true;
    } else {
      // === TIER 2: Scale from shorter real delta ===
      let scaledFromShorter: number | null = null;
      if (snapshots && snapshots.length >= 2) {
        const shorterPeriods = [180, 90, 30, 14, 7].filter(d => d < periodDays);
        for (const shorter of shorterPeriods) {
          const shorterDelta = calculateSnapshotDelta(snapshots, shorter);
          if (shorterDelta != null && shorterDelta > 0) {
            scaledFromShorter = Math.round(shorterDelta * (periodDays / shorter));
            scaledFromShorter = Math.min(scaledFromShorter, soldCount);
            break;
          }
        }
      }

      // === TIER 3: Video momentum estimate ===
      // Uses multiple signals:
      //   - Implied conversion rate from lifetime views vs sold_count
      //   - Momentum score (is this period hotter or colder than average?)
      //   - Recency boost (recent timeframes convert better on TikTok)
      const convRate = estimatedConversionRate(totalViews, periodViews, soldCount);
      const momentum = momentumScore(periodViews, totalViews, periodDays);
      const recency = recencyMultiplier(periodDays);

      // Base estimate: apply conversion rate to period views
      let velocityEstimate = Math.round(periodViews * convRate * recency);

      // Apply momentum: if views are concentrated in this period, boost sales
      if (momentum > 1) {
        velocityEstimate = Math.round(velocityEstimate * Math.min(momentum, 2.5));
      }

      // Cross-check against lifetime sold_count:
      // Period sales can't exceed total sold, and for short periods
      // shouldn't exceed a reasonable fraction of total
      const maxFraction = periodDays <= 7 ? 0.25
        : periodDays <= 14 ? 0.35
        : periodDays <= 30 ? 0.5
        : periodDays <= 90 ? 0.75
        : 1.0;
      velocityEstimate = Math.min(velocityEstimate, Math.round(soldCount * maxFraction));

      // Also compute the simple velocity ratio method as a floor
      const simpleVelocity = totalViews > 0
        ? Math.round(soldCount * (periodViews / totalViews) * recency)
        : 0;

      // Final estimate: use the highest of all available methods
      // This ensures longer periods never show less than shorter periods
      estPeriodUnitsSold = Math.max(
        scaledFromShorter || 0,
        velocityEstimate,
        simpleVelocity
      );

      // Absolute floor: if the product has real sales and real period views,
      // show at least something proportional
      if (estPeriodUnitsSold === 0 && soldCount > 0 && periodViews > 0) {
        estPeriodUnitsSold = Math.max(1, Math.round(soldCount * (periodDays / Math.max(daysActive, periodDays)) * 0.5));
      }
    }
  }

  const estRevenue = estPeriodUnitsSold * effectivePrice;
  const velocityRatio = totalViews > 0 ? periodViews / totalViews : 0;

  const conversionRate = periodViews > 0 && estPeriodUnitsSold > 0
    ? (estPeriodUnitsSold / periodViews) * 100
    : null;

  return {
    periodViews,
    periodVideoCount,
    totalViews,
    estPeriodUnitsSold,
    estRevenue,
    conversionRate,
    daysActive,
    velocityRatio,
    hasRealPrice,
    hasRealDelta,
  };
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

// Calculate median price from a list of products for a given niche
export function calculateMedianPrice(products: { sale_price: number; niche_slug?: string }[], nicheSlug: string): number {
  const withPrice = products
    .filter(p => p.sale_price > 0 && (nicheSlug === 'all' || p.niche_slug === nicheSlug))
    .map(p => p.sale_price)
    .sort((a, b) => a - b);

  if (withPrice.length === 0) return 24.99; // fallback

  const mid = Math.floor(withPrice.length / 2);
  return withPrice.length % 2 === 0
    ? (withPrice[mid - 1] + withPrice[mid]) / 2
    : withPrice[mid];
}
