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
 *
 * Requires the rankings_cache table (see pipeline/rankings_cache.sql).
 */
import { createClient } from '@supabase/supabase-js';
import { computeTopProducts } from '../api/top-products';
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
  const argNiche = process.argv[2];
  const argDays = process.argv[3] ? Number(process.argv[3]) : null;
  const niches = argNiche ? [argNiche] : NICHE_SLUGS;
  const daysList = argDays ? [argDays] : DAYS;

  console.log(
    `Precomputing rankings for ${niches.length} niche(s) × ${daysList.length} timeframe(s) = ${niches.length * daysList.length} combos\n`,
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

  for (const niche of niches) {
    for (const days of daysList) {
      await store('products', niche, days, () => computeTopProducts(niche, days), STORE_TOP_N_PRODUCTS);
      await store('videos', niche, days, () => computeTopVideos(niche, days), STORE_TOP_N_VIDEOS);
    }
  }

  console.log(
    `\nPrecompute done: ${ok} ok, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
