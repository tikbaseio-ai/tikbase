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

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}
