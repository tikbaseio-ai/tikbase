/**
 * precompute-creators.ts
 *
 * Precomputes the creator leaderboard ("top affiliates by GMV") for every
 * niche × window and stores each result in the `creator_rankings` table, so the
 * 1b read path is an instant table read — the same shape as rankings_cache /
 * api/top-products.
 *
 * Reads only from Supabase (product_videos, products, rankings_cache). Makes
 * ZERO ScrapeCreators calls and therefore costs no API credits; it can be run
 * at any time.
 *
 * Usage:
 *   tsx --env-file=.env pipeline/precompute-creators.ts              # all combos, writes
 *   tsx --env-file=.env pipeline/precompute-creators.ts --dry-run    # READ-ONLY, prints top 10 for all:30
 *   tsx --env-file=.env pipeline/precompute-creators.ts --dry-run 7  # dry-run a specific window
 *
 * Requires migrations/manual/2026-07-28-creators.sql to have been applied.
 */
import { createClient } from '@supabase/supabase-js';

const NICHE_SLUGS = [
  'all', 'beauty-skincare', 'gym-fitness', 'health-wellness', 'mens-wear',
  'womens-wear', 'tech-gadgets', 'pet-products', 'home-kitchen', 'food-beverage',
  'shoes-footwear', 'accessories-jewelry', 'baby-kids', 'toys-games', 'fragrance',
  'makeup', 'supplements', 'mens-grooming', 'haircare',
];
// The leaderboard windows. Both must exist as products:<niche>:<days> keys in
// rankings_cache, because that is where per-product revenue is sourced.
const WINDOWS = [7, 30];
const STORE_TOP_N_CREATORS = 400;
const TOP_PRODUCTS_PER_CREATOR = 5;
const PAGE = 1000;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface VideoRow {
  creator_key: string;
  product_id: string;
  video_id: string | null;
  view_count: number | null;
  posted_at: string | null;
  ad_label: string | null;
}
interface CreatorRow {
  creator_key: string;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  author_id: string | null;
}
interface ProductRow {
  product_id: string;
  niche_slug: string | null;
  title: string | null;
}
interface RevenueEntry {
  estRevenue: number;
  hasRealDelta: boolean;
}

// A commissioned video. Matches the TikTok disclosure badge stored in ad_label
// (verified live 2026-07-27: the payload field is bc_ad_label_text, and the
// dominant value by far is "Creator earns commission").
function isCommissioned(adLabel: string | null): boolean {
  return /commission/i.test(adLabel || '');
}

// Post date for a video. posted_at is only populated on related_videos rows
// (73,724 of 196,105 = 37.6%), so the rest fall back to the video-id snowflake:
// timestamp = (id >> 32) as unix seconds.
//
// Validated 2026-07-28 against the 73,724 rows carrying BOTH values — on a
// 1,000-row unbiased sample, 87.5% agree within 60s, 98.8% within a day, and
// 97.9% land on the same UTC date. That is sufficient for day-granularity
// windowing, which is the only thing this is used for.
function postDate(v: VideoRow): Date | null {
  if (v.posted_at) {
    const t = Date.parse(v.posted_at);
    if (!Number.isNaN(t)) return new Date(t);
  }
  if (v.video_id && /^[0-9]{10,}$/.test(v.video_id)) {
    try {
      const secs = Number(BigInt(v.video_id) >> 32n);
      const d = new Date(secs * 1000);
      const y = d.getUTCFullYear();
      if (y >= 2016 && y <= 2030) return d;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// Keyset pagination on a unique orderable column. OFFSET degrades badly past a
// few thousand rows on these tables, and product_videos is ~196k.
async function pageAll<T>(
  table: string,
  select: string,
  orderCol: string,
  tweak?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  let last = '';
  while (true) {
    let q = supabase.from(table).select(select).order(orderCol, { ascending: true }).limit(PAGE);
    if (last) q = q.gt(orderCol, last);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as any as T[]));
    last = (data[data.length - 1] as any)[orderCol];
    if (data.length < PAGE) break;
  }
  return out;
}

// Derive creator_key from a video URL. MUST stay identical to the backfill
// expression in migrations/manual/2026-07-28-creators.sql — this is the same
// rule expressed twice, and a divergence would silently split every creator.
//
// 'user' is phase 1's placeholder for a missing unique_id, not an identity, so
// it yields null rather than collapsing those videos into one fake creator.
const URL_HANDLE = /tiktok\.com\/@([^/?#]+)\/video\//i;
export function deriveCreatorKey(videoUrl: string | null): string | null {
  const m = URL_HANDLE.exec(videoUrl || '');
  if (!m) return null;
  const h = m[1];
  if (h === 'user') return null;
  return /^[0-9]{6,}$/.test(h) ? `id:${h}` : h.toLowerCase();
}

// Per-product revenue for a window, sourced from the rankings_cache payload that
// precompute-rankings.ts already wrote. v1 covers RANKED products only: a
// product absent from the payload contributes 0 GMV, which means creators who
// only promote unranked products score 0. Stated rather than hidden — closing it
// needs a revenue model for the whole catalogue, not just the top 400 per niche.
async function loadRevenue(niche: string, days: number): Promise<Map<string, RevenueEntry>> {
  const { data, error } = await supabase
    .from('rankings_cache')
    .select('payload')
    .eq('cache_key', `products:${niche}:${days}`)
    .maybeSingle();
  const m = new Map<string, RevenueEntry>();
  if (error || !data || !Array.isArray((data as any).payload)) return m;
  for (const p of (data as any).payload) {
    const pid = p?.product_id;
    if (!pid) continue;
    const met = p?.metrics || {};
    m.set(String(pid), {
      estRevenue: Number(met.estRevenue) || 0,
      hasRealDelta: Boolean(met.hasRealDelta),
    });
  }
  return m;
}

interface CreatorAgg {
  creator_key: string;
  videos_posted: number;
  views_on_window_videos: number;
  commissioned_videos: number;
  products: Map<string, { views: number; videos: number }>;
}

/**
 * Compute the leaderboard for one niche × window.
 *
 * GMV ATTRIBUTION — this is a MODELLED number, not measured revenue.
 * For each product, the window's estimated revenue is split across the creators
 * who posted about it in that window, in proportion to their share of views on
 * that product's window videos:
 *
 *   creator_gmv = SUM over products of
 *                 productRevenue[p] * (creatorViewsOnP / allCreatorViewsOnP)
 *
 * Both view terms are LIFETIME view counts on videos POSTED IN THE WINDOW — we
 * do not snapshot view history, so a window's "views" cannot mean views accrued
 * during the window. gmv_confidence reports the share of a creator's attributed
 * GMV that came from products whose revenue was backed by a real snapshot delta
 * (hasRealDelta) rather than the estimator.
 */
function computeLeaderboard(
  videos: VideoRow[],
  creators: Map<string, CreatorRow>,
  productNiche: Map<string, ProductRow>,
  revenue: Map<string, RevenueEntry>,
  niche: string,
  days: number,
  now: number,
): any[] {
  const cutoff = now - days * 86400000;

  // 1. Window videos, restricted to the niche when one is requested.
  const inWindow: { v: VideoRow; views: number }[] = [];
  for (const v of videos) {
    if (!v.creator_key) continue;
    if (niche !== 'all') {
      const p = productNiche.get(v.product_id);
      if (!p || p.niche_slug !== niche) continue;
    }
    const d = postDate(v);
    if (!d) continue;
    const t = d.getTime();
    if (t < cutoff || t > now) continue;
    inWindow.push({ v, views: Math.max(0, v.view_count || 0) });
  }

  // 2. Denominator for attribution: all window views per product.
  const productWindowViews = new Map<string, number>();
  for (const { v, views } of inWindow) {
    productWindowViews.set(v.product_id, (productWindowViews.get(v.product_id) || 0) + views);
  }

  // 3. Fold per creator.
  const aggs = new Map<string, CreatorAgg>();
  for (const { v, views } of inWindow) {
    let a = aggs.get(v.creator_key);
    if (!a) {
      a = {
        creator_key: v.creator_key,
        videos_posted: 0,
        views_on_window_videos: 0,
        commissioned_videos: 0,
        products: new Map(),
      };
      aggs.set(v.creator_key, a);
    }
    a.videos_posted++;
    a.views_on_window_videos += views;
    if (isCommissioned(v.ad_label)) a.commissioned_videos++;
    const pe = a.products.get(v.product_id) || { views: 0, videos: 0 };
    pe.views += views;
    pe.videos++;
    a.products.set(v.product_id, pe);
  }

  // 4. Attribute GMV and shape the payload rows.
  const out: any[] = [];
  for (const a of aggs.values()) {
    let gmv = 0;
    let gmvReal = 0;
    for (const [pid, pe] of a.products) {
      const rev = revenue.get(pid);
      if (!rev || rev.estRevenue <= 0) continue; // unranked product -> 0, by design
      const denom = productWindowViews.get(pid) || 0;
      if (denom <= 0) continue;
      const share = pe.views / denom;
      const attributed = rev.estRevenue * share;
      gmv += attributed;
      if (rev.hasRealDelta) gmvReal += attributed;
    }

    // dominant_niche: mode of the promoted products' niche_slug.
    const nicheCount = new Map<string, number>();
    for (const pid of a.products.keys()) {
      const ns = productNiche.get(pid)?.niche_slug;
      if (ns) nicheCount.set(ns, (nicheCount.get(ns) || 0) + 1);
    }
    let dominantNiche: string | null = null;
    let best = 0;
    for (const [ns, n] of nicheCount) {
      if (n > best) {
        best = n;
        dominantNiche = ns;
      }
    }

    const topProducts = [...a.products.entries()]
      .sort((x, y) => y[1].views - x[1].views)
      .slice(0, TOP_PRODUCTS_PER_CREATOR)
      .map(([pid, pe]) => ({
        product_id: pid,
        title: productNiche.get(pid)?.title ?? null,
        niche_slug: productNiche.get(pid)?.niche_slug ?? null,
        videos: pe.videos,
        views: pe.views,
      }));

    const c = creators.get(a.creator_key);
    out.push({
      creator_key: a.creator_key,
      display_name: c?.display_name ?? null,
      avatar_url: c?.avatar_url ?? null,
      handle: c?.handle ?? null,
      author_id: c?.author_id ?? null,
      metrics: {
        // MODELLED — see computeLeaderboard docblock.
        attributedGmv: Math.round(gmv * 100) / 100,
        // Share of attributedGmv from products with a real snapshot delta.
        gmvConfidence: gmv > 0 ? Math.round((gmvReal / gmv) * 1000) / 1000 : 0,
        videosPosted: a.videos_posted,
        distinctProducts: a.products.size,
        // LIFETIME views on videos POSTED IN THE WINDOW — not views accrued
        // during the window. We do not snapshot view history.
        viewsOnWindowVideos: a.views_on_window_videos,
        affiliateIntensity:
          a.videos_posted > 0
            ? Math.round((a.commissioned_videos / a.videos_posted) * 1000) / 1000
            : 0,
        dominantNiche,
      },
      topProducts,
    });
  }

  out.sort((x, y) => y.metrics.attributedGmv - x.metrics.attributedGmv);
  return out;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const argWindow = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const started = Date.now();

  // Guard: the migration creates creator_rankings. A write run without it would
  // half-run, so bail. A dry run does not write, and derives keys itself, so it
  // is allowed to proceed pre-migration — that is how the aggregation is
  // verified against production before any DDL is applied.
  const probe = await supabase.from('creator_rankings').select('cache_key').limit(1);
  const migrated = !probe.error;
  if (!migrated) {
    const msg =
      `creator_rankings is not queryable: ${probe.error?.message}\n` +
      `  Run migrations/manual/2026-07-28-creators.sql in the Supabase SQL editor.`;
    if (!dryRun) {
      console.error(`\n  ${'!'.repeat(60)}\n  ${msg}\n  ${'!'.repeat(60)}\n`);
      process.exit(1);
    }
    console.log(`  [pre-migration dry run] ${msg}`);
    console.log('  Deriving creator_key from video_url in memory instead.\n');
  }

  console.log('Loading creators, products and videos from Supabase...');
  const t0 = Date.now();

  const creators = new Map<string, CreatorRow>();
  if (migrated) {
    const creatorRows = await pageAll<CreatorRow>(
      'creators',
      'creator_key,display_name,avatar_url,handle,author_id',
      'creator_key',
    );
    for (const c of creatorRows) creators.set(c.creator_key, c);
  }

  const productRows = await pageAll<ProductRow & { id: string }>(
    'products',
    'id,product_id,niche_slug,title',
    'id',
  );
  const productNiche = new Map<string, ProductRow>();
  for (const p of productRows) productNiche.set(p.product_id, p);

  // Pre-migration the creator_key column does not exist, so select video_url and
  // derive. Post-migration read the stored column and skip unkeyed rows.
  const videoSelect = migrated
    ? 'id,creator_key,product_id,video_id,view_count,posted_at,ad_label'
    : 'id,video_url,product_id,video_id,view_count,posted_at,ad_label,author_name,author_avatar_url';
  const rawVideos = await pageAll<any>(
    'product_videos',
    videoSelect,
    'id',
    migrated ? (q) => q.not('creator_key', 'is', null) : undefined,
  );

  const videoRows: VideoRow[] = [];
  for (const r of rawVideos) {
    const ck = migrated ? r.creator_key : deriveCreatorKey(r.video_url);
    if (!ck) continue;
    videoRows.push({
      creator_key: ck,
      product_id: r.product_id,
      video_id: r.video_id,
      view_count: r.view_count,
      posted_at: r.posted_at,
      ad_label: r.ad_label,
    });
    // Pre-migration, synthesise the creator row the migration would have built:
    // newest-seen display name and avatar.
    if (!migrated && !creators.has(ck)) {
      creators.set(ck, {
        creator_key: ck,
        display_name: r.author_name ?? null,
        avatar_url: r.author_avatar_url ?? null,
        handle: ck.startsWith('id:') ? null : ck,
        author_id: ck.startsWith('id:') ? ck.slice(3) : null,
      });
    }
  }

  console.log(
    `  loaded ${creators.size} creators, ${productNiche.size} products, ` +
    `${videoRows.length} keyed videos (of ${rawVideos.length} rows) ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  const now = Date.now();
  const windows = argWindow ? [Number(argWindow)] : WINDOWS;

  if (dryRun) {
    const days = windows[0] ?? 30;
    const ni = process.argv.indexOf('--niche');
    const dryNiche = ni >= 0 ? process.argv[ni + 1] : 'all';
    const revenue = await loadRevenue(dryNiche, days);
    const realDeltaProducts = [...revenue.values()].filter((r) => r.hasRealDelta).length;
    const ranked = computeLeaderboard(
      videoRows, creators, productNiche, revenue, dryNiche, days, now,
    );
    console.log(
      `\n=== DRY RUN (no writes) — creators:${dryNiche}:${days} — ` +
      `${ranked.length} creators, revenue source has ${revenue.size} ranked products ` +
      `(${realDeltaProducts} with hasRealDelta) ===\n`,
    );
    console.log(
      'rank  attributedGmv   conf   vids  prods       views  aff%  niche               creator',
    );
    for (const [i, c] of ranked.slice(0, 10).entries()) {
      const m = c.metrics;
      console.log(
        `${String(i + 1).padStart(4)}  ` +
        `$${m.attributedGmv.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(12)}  ` +
        `${m.gmvConfidence.toFixed(2)}  ` +
        `${String(m.videosPosted).padStart(4)}  ` +
        `${String(m.distinctProducts).padStart(5)}  ` +
        `${m.viewsOnWindowVideos.toLocaleString('en-US').padStart(11)}  ` +
        `${(m.affiliateIntensity * 100).toFixed(0).padStart(3)}%  ` +
        `${(m.dominantNiche || '-').padEnd(18)}  ` +
        `${c.handle ? '@' + c.handle : c.creator_key} (${c.display_name ?? '?'})`,
      );
    }

    const totalGmv = ranked.reduce((s, c) => s + c.metrics.attributedGmv, 0);
    const top100 = ranked.slice(0, 100).reduce((s, c) => s + c.metrics.attributedGmv, 0);
    const withGmv = ranked.filter((c) => c.metrics.attributedGmv > 0);
    const confs = withGmv.map((c) => c.metrics.gmvConfidence).sort((a, b) => a - b);
    console.log(
      `\n  creators with GMV > 0: ${withGmv.length} / ${ranked.length}` +
      `\n  total attributed GMV : $${totalGmv.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
      `\n  top-100 GMV share    : ${totalGmv > 0 ? ((100 * top100) / totalGmv).toFixed(1) : '0'}%` +
      `\n  median gmvConfidence : ${confs.length ? confs[Math.floor(confs.length / 2)].toFixed(3) : 'n/a'}`,
    );
    console.log(`\nDry run done in ${((Date.now() - started) / 1000).toFixed(1)}s — nothing written.`);
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const days of windows) {
    for (const niche of NICHE_SLUGS) {
      const t = Date.now();
      try {
        const revenue = await loadRevenue(niche, days);
        const ranked = computeLeaderboard(
          videoRows, creators, productNiche, revenue, niche, days, now,
        );
        const payload = ranked.slice(0, STORE_TOP_N_CREATORS);
        const { error } = await supabase.from('creator_rankings').upsert(
          {
            cache_key: `creators:${niche}:${days}`,
            payload,
            creator_count: ranked.length,
            computed_at: new Date().toISOString(),
          },
          { onConflict: 'cache_key' },
        );
        if (error) throw new Error(error.message);
        ok++;
        console.log(
          `  ✓ creators:${niche}:${days} — ${ranked.length} creators ` +
          `(stored ${payload.length}) in ${((Date.now() - t) / 1000).toFixed(1)}s`,
        );
      } catch (e: any) {
        fail++;
        console.error(`  ✗ creators:${niche}:${days} — ${e?.message || e}`);
      }
    }
  }

  console.log(
    `\nCreator precompute done: ${ok} ok, ${fail} failed in ` +
    `${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
