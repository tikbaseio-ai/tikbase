// Reads product_sold_series and turns it into Trend objects. The maths is in
// trend-math.ts; this file is only I/O and caching.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeTrend, historyNeeded, isoDay,
  type SoldPoint, type Trend, type TrendRange,
} from './trend-math.js';

// Products per RPC call. Row count is one per product, but each carries a jsonb
// array of up to ~187 points at 90d, so keep the payload modest and well inside
// the 8s authenticator statement_timeout.
const CHUNK = 50;

// Snapshots land once a day; a trend does not change inside an hour. Per
// instance, like the other in-memory caches here - a cold start just re-reads.
const TTL_MS = 60 * 60 * 1000;
const memo = new Map<string, { trend: Trend; at: number }>();

const today = () => isoDay(Date.now());

/**
 * Trend per product id. A product the RPC returned nothing for gets a
 * 'no-history' trend, never an omitted key and never zeros. A chunk that fails
 * is left OUT of the map entirely: the caller must treat missing as "could not
 * read", which is a different claim from "no history".
 */
export async function loadTrends(
  supabase: SupabaseClient,
  ids: string[],
  range: TrendRange,
): Promise<{ trends: Map<string, Trend>; failed: number }> {
  const trends = new Map<string, Trend>();
  const now = Date.now();
  const need: string[] = [];
  for (const id of ids) {
    const hit = memo.get(`${range}:${id}`);
    if (hit && now - hit.at < TTL_MS) trends.set(id, hit.trend);
    else need.push(id);
  }

  let failed = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK);
    const { data, error } = await supabase.rpc('product_sold_series', {
      p_product_ids: chunk,
      p_days: historyNeeded(range),
    });
    if (error) {
      console.warn(`  [WARN] product_sold_series chunk failed: ${error.message}`);
      failed += chunk.length;
      continue;
    }
    const byId = new Map<string, SoldPoint[]>();
    for (const r of (data as any[]) || []) {
      byId.set(
        String(r.product_id),
        ((r.points as any[]) || []).map((p) => ({
          date: String(p[0]), sold: p[1] == null ? null : Number(p[1]),
          price: p[2] == null ? null : Number(p[2]),
        })),
      );
    }
    for (const id of chunk) {
      const trend = computeTrend(byId.get(id) ?? [], range, today());
      trends.set(id, trend);
      memo.set(`${range}:${id}`, { trend, at: now });
    }
  }
  if (memo.size > 20_000) {
    for (const [k, v] of memo) if (now - v.at >= TTL_MS) memo.delete(k);
  }
  return { trends, failed };
}
