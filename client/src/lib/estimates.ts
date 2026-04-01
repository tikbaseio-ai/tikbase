// Product metrics based on video velocity ratio + snapshot deltas when available.
// Rankings are driven by actual video views within each timeframe.
// Revenue is estimated using: video velocity as a proxy for sales distribution.

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
  // AND we have meaningful time span (baseline must be before cutoff date)
  if (baseline.snapshot_date > cutoffStr) return null; // all snapshots are within the period
  if (baseline.snapshot_date >= latest.snapshot_date) return null;

  const unitsDelta = Math.max(0, (latest.sold_count || 0) - (baseline.sold_count || 0));

  // Sanity check: delta shouldn't exceed lifetime total
  const lifetimeSold = latest.sold_count || 0;
  if (unitsDelta > lifetimeSold) return null;
  if (periodDays <= 14 && unitsDelta > lifetimeSold * 0.5 && lifetimeSold > 10000) {
    return null; // bad data, fall back
  }

  return unitsDelta;
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
    // No period views = no evidence of sales this period. Hard zero.
    estPeriodUnitsSold = 0;
  } else {
    // We have period views — now find the best sales estimate

    // 1. Try exact-period snapshot delta
    const exactDelta = snapshots ? calculateSnapshotDelta(snapshots, periodDays) : null;

    if (exactDelta != null && exactDelta >= 0) {
      // BEST: real snapshot delta for this exact period
      estPeriodUnitsSold = exactDelta;
      hasRealDelta = true;
    } else {
      // 2. Try scaling up from a shorter real delta (consistency floor)
      //    If we know 1,274 sold in 7 days, 14-day estimate must be >= 1,274
      let scaledFromShorter: number | null = null;
      if (snapshots && snapshots.length >= 2) {
        const shorterPeriods = [180, 90, 30, 14, 7].filter(d => d < periodDays);
        for (const shorter of shorterPeriods) {
          const shorterDelta = calculateSnapshotDelta(snapshots, shorter);
          if (shorterDelta != null && shorterDelta > 0) {
            // Scale proportionally: 1,274 in 7 days → ~2,548 in 14 days
            scaledFromShorter = Math.round(shorterDelta * (periodDays / shorter));
            scaledFromShorter = Math.min(scaledFromShorter, soldCount);
            break; // use the longest shorter period with real data
          }
        }
      }

      // 3. Velocity ratio estimate
      let velocityEstimate = 0;
      if (totalViews > 0 && periodViews > 0) {
        const velocityRatio = periodViews / totalViews;
        const recencyBoost = periodDays <= 7 ? 1.4
          : periodDays <= 14 ? 1.25
          : periodDays <= 30 ? 1.15
          : 1.0;
        velocityEstimate = Math.round(soldCount * velocityRatio * recencyBoost);
        velocityEstimate = Math.min(velocityEstimate, soldCount);
      }

      // Use the HIGHER of scaled-from-shorter and velocity estimate
      // This ensures longer periods never show less than shorter periods
      estPeriodUnitsSold = Math.max(scaledFromShorter || 0, velocityEstimate);
    }
  }

  const estRevenue = estPeriodUnitsSold * effectivePrice;
  const velocityRatio = totalViews > 0 ? periodViews / totalViews : 0;

  // Conversion rate — only meaningful when we have period views
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
