// The shape of the metrics block the API sends down, and the one formatter the
// pages share.
//
// The estimation engine itself used to live here as a second implementation of
// api/top-products.ts. Nothing in the client ever called it — every figure on
// screen is computed server-side and arrives precomputed in the rankings_cache
// payload — so the copy could only ever drift, and it had: the snapshot-bounds
// fix (2026-08-03) and the zero-baseline guard that followed it landed on the
// server alone, leaving this file quietly describing a model the product no
// longer uses. Deleted rather than resynced; the server owns estimation.

// null means UNKNOWN, and only ever that. The view fields go null when the
// server could not read a product's view stats — see viewsUnknown. They are
// never null to mean zero: a product with no videos reports 0, because the
// query answered and the answer was none.
export interface ProductEstimates {
  periodViews: number | null;        // views from videos posted within this timeframe
  periodVideoCount: number | null;   // number of videos posted within this timeframe
  totalViews: number | null;         // lifetime views across all videos
  estPeriodUnitsSold: number | null; // estimated units sold in this period
  estRevenue: number | null;         // estimated revenue for the period
  conversionRate: number | null;
  daysActive: number;
  velocityRatio: number | null;      // what % of total views came from this period
  hasRealPrice: boolean;      // true if product has a real price (not category median)
  hasRealDelta: boolean;      // true if estPeriodUnitsSold came from real snapshots
  /** The view-stats read failed for this product. Its view fields are unknown,
   *  not zero, and any estimate present came from a measured snapshot delta. */
  viewsUnknown?: boolean;
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}
