/**
 * precompute-rankings.ts
 *
 * Precomputes the Top Products ranking for every niche × timeframe and stores
 * each result (top-N enriched products) in the `rankings_cache` table. The
 * /api/top-products endpoint then serves an instant table read instead of a
 * 15–120s live computation.
 *
 * Reuses the exact ranking logic from api/top-products.ts (single source of
 * truth — no duplication). Reads only from Supabase (products / videos /
 * snapshots already collected) — NO ScrapeCreators calls, so it costs no
 * API credits and can be run any time.
 *
 * Usage:
 *   tsx --env-file=.env pipeline/precompute-rankings.ts            # all combos
 *   tsx --env-file=.env pipeline/precompute-rankings.ts all 7      # one combo (testing)
 *   tsx --env-file=.env pipeline/precompute-rankings.ts all        # one niche, all timeframes
 *   tsx --env-file=.env pipeline/precompute-rankings.ts all 30 --dry-run   # READ-ONLY
 *
 * Requires the rankings_cache table (see pipeline/rankings_cache.sql).
 */
import { createClient } from '@supabase/supabase-js';
import { computeTopProducts, loadWindowStats } from '../api/top-products';
import { computeTopVideos } from '../api/top-videos';

const NICHE_SLUGS = [
  'all', 'beauty-skincare', 'gym-fitness', 'health-wellness', 'mens-wear',
  'womens-wear', 'tech-gadgets', 'pet-products', 'home-kitchen', 'food-beverage',
  'shoes-footwear', 'accessories-jewelry', 'baby-kids', 'toys-games', 'fragrance',
];
const DAYS = [7, 14, 30, 90, 180, 365];
const STORE_TOP_N_PRODUCTS = 400; // enough for pagination; free tier is capped anyway
const STORE_TOP_N_VIDEOS = 300;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // Optional CLI filters for isolated testing.
  const dryRun = process.argv.includes('--dry-run');
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const argNiche = positional[0];
  const argDays = positional[1] ? Number(positional[1]) : null;
  const niches = argNiche ? [argNiche] : NICHE_SLUGS;
  const daysList = argDays ? [argDays] : DAYS;

  console.log(
    `Precomputing rankings for ${niches.length} niche(s) × ${daysList.length} timeframe(s) = ${niches.length * daysList.length} combos${dryRun ? ' — DRY RUN, nothing written' : ''}\n`,
  );

  const started = Date.now();
  let ok = 0;
  let fail = 0;

  // Compute one ranking, store the top-N as a rankings_cache row.
  async function store(
    kind: 'products' | 'videos',
    niche: string,
    days: number,
    compute: () => Promise<any[]>,
    topN: number,
  ) {
    const t0 = Date.now();
    try {
      const ranked = await compute();
      const payload = ranked.slice(0, topN);

      // READ-ONLY verification path: print the payload rather than storing it.
      if (dryRun) {
        console.log(
          `  [dry-run] ${kind}:${niche}:${days} — ${ranked.length} rows ` +
          `(would store ${payload.length}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
        if (kind === 'products') {
          console.log(
            '    rank  revenue        sold  creators  aff%   opp  conf   product',
          );
          for (const [i, p] of payload.slice(0, 10).entries()) {
            const m = p.metrics || {};
            const aff = p.affiliate_intensity;
            console.log(
              `    ${String(i + 1).padStart(4)}  ` +
              `$${(m.estRevenue || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)}  ` +
              `${String(m.estPeriodUnitsSold ?? 0).padStart(5)}  ` +
              `${String(p.distinct_creators ?? 0).padStart(8)}  ` +
              `${(aff === null || aff === undefined ? '—' : `${Math.round(aff * 100)}%`).padStart(4)}  ` +
              `${p.opportunity ? 'YES' : ' - '}  ` +
              `${m.hasRealDelta ? 'real' : 'est '}  ` +
              `${String(p.title ?? p.product_id).slice(0, 52)}`,
            );
          }
        }
        ok++;
        return;
      }

      const { error } = await supabase.from('rankings_cache').upsert(
        {
          cache_key: `${kind}:${niche}:${days}`,
          payload,
          product_count: ranked.length,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'cache_key' },
      );
      if (error) throw new Error(error.message);
      ok++;
      console.log(
        `  ✓ ${kind}:${niche}:${days} — ${ranked.length} rows (stored ${payload.length}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    } catch (e: any) {
      fail++;
      console.error(`  ✗ ${kind}:${niche}:${days} — ${e?.message || e}`);
    }
  }

  // Warm the per-window creator aggregate ONCE per window, before the niche
  // loop. computeTopProducts memoises it, so this is what keeps the addition at
  // one query per window (~9s each, measured) instead of one per niche x window
  // (90 queries, ~13 min). Timed explicitly so the runtime delta of the 1c/2
  // enrichment is visible in the job log rather than inferred.
  const warmStart = Date.now();
  for (const days of daysList) {
    const t = Date.now();
    const stats = await loadWindowStats(days);
    console.log(
      `  window stats ${days}d — ${stats.size} products with videos in window ` +
      `in ${((Date.now() - t) / 1000).toFixed(1)}s`,
    );
  }
  const warmMs = Date.now() - warmStart;
  console.log(
    `  window-stats total: ${(warmMs / 1000).toFixed(1)}s for ${daysList.length} window(s)\n`,
  );

  for (const niche of niches) {
    for (const days of daysList) {
      await store('products', niche, days, () => computeTopProducts(niche, days), STORE_TOP_N_PRODUCTS);
      await store('videos', niche, days, () => computeTopVideos(niche, days), STORE_TOP_N_VIDEOS);
    }
  }

  // Refresh the materialised 30-day revenue lookup that product search ranks by
  // and the product page reads. It is derived from the payloads just written, so
  // it belongs here rather than in a request. Non-fatal: a stale lookup mis-ranks
  // search slightly, which is not worth failing a precompute over.
  if (!dryRun) {
    const { data: revRows, error: revErr } = await supabase.rpc('refresh_product_revenue_30d');
    if (revErr) console.warn(`  [WARN] refresh_product_revenue_30d failed: ${revErr.message}`);
    else console.log(`  product 30d revenue lookup refreshed: ${revRows ?? 0} rows`);
  }

  console.log(
    `\nPrecompute done: ${ok} ok, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
