/**
 * warm-avatars.ts — cache creator avatars while their signed URLs are still fresh.
 *
 * THE TIMING IS THE WHOLE POINT. TikTok avatar URLs carry an `x-expires` that
 * lapses within roughly a day, and once it does the bytes are unreachable
 * forever — api/avatar's request-time miss path can only 403 and fall back to a
 * placeholder. Measured against production on 2026-07-30: of 109,737 rows in
 * `creators` with an avatar_url, ZERO were still inside their signed window.
 * Warming on demand is therefore not a thing that can work; warming at the
 * moment the pipeline has just seen the URL is.
 *
 * So this runs at the end of the nightly creator precompute, over the creators
 * that actually render (top N of each niche x window payload, deduped — a few
 * hundred, not the 110k tail), and writes through the same storage path
 * api/avatar reads (shared/avatar-cache.ts).
 *
 * Costs ZERO ScrapeCreators credits: these are plain CDN image fetches plus
 * Supabase Storage writes. It never throws and never fails the run — a cold
 * avatar cache degrades to a placeholder, which is not worth losing a
 * leaderboard over.
 *
 * URL SOURCING. `creators.avatar_url` is copied in at aggregation time and is
 * usually already stale, so this does not trust it as the only source. The
 * freshest signed URL for a creator is whatever the most recently inserted
 * `product_videos` row carries, so a bounded scan of recent rows wins over the
 * aggregate. Those new rows also tend to have `creator_key` still null (the
 * migration backfilled once and nothing repopulates it), which is why keys are
 * derived here rather than filtered on.
 *
 * Usage (standalone, e.g. to warm today's leaderboard without waiting a night):
 *   tsx --env-file=.env pipeline/warm-avatars.ts             # warm top 50/payload
 *   tsx --env-file=.env pipeline/warm-avatars.ts --dry-run   # report, write nothing
 *   tsx --env-file=.env pipeline/warm-avatars.ts --top 100   # deeper render set
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  avatarStorageName,
  cacheAvatar,
  isSignedUrlLive,
  listCachedAvatars,
  signedUrlExpiryMs,
} from '../shared/avatar-cache';
import { deriveCreatorKey } from '../shared/creator-key';

/** How deep into each niche x window payload to warm. The page shows 50/page. */
export const WARM_TOP_N_PER_PAYLOAD = 50;
/** Bounded in-flight CDN fetches — same ceiling the other pipeline jobs use. */
const CONCURRENCY = 8;
/** Re-fetch an avatar at most this often; faces change rarely. */
const RECACHE_AFTER_DAYS = 7;
const PAGE = 1000;
/** Hard ceiling on fetches per run, so a bad day cannot balloon into a spend. */
const MAX_FETCHES = 1200;

export interface WarmStats {
  targets: number;
  alreadyCached: number;
  noLiveUrl: number;
  attempted: number;
  stored: number;
  failed: number;
  bytes: number;
  skippedByCap: number;
  elapsedMs: number;
}

/** Bounded-concurrency pool — never Promise.all the whole list. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runner = async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

/**
 * Freshest still-valid signed avatar URL per wanted creator, from product_videos.
 *
 * One full keyset pass over the table on `id`, deciding liveness in memory. That
 * is deliberate, and the cheaper-looking shapes were measured and rejected:
 *
 *   - Filtering/ordering on created_at cancels on statement timeout — the column
 *     is unindexed, and `id` is a random uuid, so it carries no recency either.
 *   - `where creator_key is null` — which is precisely where the fresh rows are,
 *     since the migration backfilled the column once and nothing repopulates it
 *     — is not index-served (the index is partial ON the not-null rows) and also
 *     times out, ~13k rows in.
 *   - Reading only the wanted creators' keyed rows IS index-served and fast, but
 *     it misses the rows inserted by the run this warmer is attached to, which
 *     are exactly the ones whose signatures are still valid. Yesterday's keyed
 *     rows have already lapsed by the time the nightly job reaches this step.
 *
 * So the full pass is what actually finds live URLs. Measured on prod
 * 2026-07-30: 346,174 rows in ~9 min. Populating creator_key on insert (or a
 * partial index on the null rows) would make this a targeted read instead.
 */
async function loadFreshUrls(
  supabase: SupabaseClient,
  wanted: Set<string>,
  now: number,
): Promise<Map<string, string>> {
  const best = new Map<string, { url: string; exp: number }>();
  let last = '';
  let scanned = 0;

  for (;;) {
    let q = supabase
      .from('product_videos')
      .select('id,creator_key,video_url,author_avatar_url')
      .not('author_avatar_url', 'is', null)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (last) q = q.gt('id', last);
    const { data, error } = await q;
    if (error) {
      // Partial results are still useful: warm what we found and move on.
      console.warn(`  [warm] fresh-url scan stopped early: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    scanned += data.length;

    for (const r of data as any[]) {
      const key = r.creator_key || deriveCreatorKey(r.video_url);
      if (!key || !wanted.has(key)) continue;
      const url = r.author_avatar_url as string;
      if (!isSignedUrlLive(url, now)) continue;
      // Furthest expiry wins. An unsigned URL has nothing to compare, so treat it
      // as barely-live: any real signature outranks it.
      const exp = signedUrlExpiryMs(url) ?? now + 1;
      const prev = best.get(key);
      if (!prev || exp > prev.exp) best.set(key, { url, exp });
    }

    last = (data[data.length - 1] as any).id;
    if (data.length < PAGE) break;
  }

  console.log(`  [warm] scanned ${scanned} video rows, ${best.size} targets have a live url`);
  const out = new Map<string, string>();
  for (const [k, v] of best) out.set(k, v.url);
  return out;
}

/**
 * Warm the avatar cache for the given creator keys. Returns counts; never throws.
 */
export async function warmAvatars(
  supabase: SupabaseClient,
  creatorKeys: string[],
  opts: { dryRun?: boolean } = {},
): Promise<WarmStats> {
  const t0 = Date.now();
  const stats: WarmStats = {
    targets: creatorKeys.length,
    alreadyCached: 0,
    noLiveUrl: 0,
    attempted: 0,
    stored: 0,
    failed: 0,
    bytes: 0,
    skippedByCap: 0,
    elapsedMs: 0,
  };
  if (creatorKeys.length === 0) {
    stats.elapsedMs = Date.now() - t0;
    return stats;
  }

  try {
    const now = Date.now();
    const cached = await listCachedAvatars(supabase);
    const freshCutoff = now - RECACHE_AFTER_DAYS * 86400000;

    const needed: string[] = [];
    for (const key of creatorKeys) {
      const stamp = cached.get(avatarStorageName(key));
      if (stamp !== undefined && stamp >= freshCutoff) {
        stats.alreadyCached++;
        continue;
      }
      needed.push(key);
    }
    if (needed.length === 0) {
      console.log(`  [warm] all ${stats.targets} target avatars already cached this week`);
      stats.elapsedMs = Date.now() - t0;
      return stats;
    }

    // Prefer a freshly-seen URL; fall back to the aggregate's copy, which is
    // usually expired but costs nothing to try when nothing better exists.
    const fresh = await loadFreshUrls(supabase, new Set(needed), now);
    const fallback = new Map<string, string>();
    for (let i = 0; i < needed.length; i += 200) {
      const chunk = needed.slice(i, i + 200).filter((k) => !fresh.has(k));
      if (chunk.length === 0) continue;
      const { data } = await supabase
        .from('creators')
        .select('creator_key,avatar_url')
        .in('creator_key', chunk);
      for (const r of (data || []) as any[]) {
        if (r.avatar_url && isSignedUrlLive(r.avatar_url, now)) {
          fallback.set(r.creator_key, r.avatar_url);
        }
      }
    }

    const work: { key: string; url: string }[] = [];
    for (const key of needed) {
      const url = fresh.get(key) || fallback.get(key);
      if (!url) {
        stats.noLiveUrl++;
        continue;
      }
      work.push({ key, url });
    }
    if (work.length > MAX_FETCHES) {
      stats.skippedByCap = work.length - MAX_FETCHES;
      work.length = MAX_FETCHES;
    }

    console.log(
      `  [warm] ${stats.targets} targets: ${stats.alreadyCached} cached, ` +
      `${stats.noLiveUrl} without a live url, ${work.length} to fetch` +
      (stats.skippedByCap ? ` (${stats.skippedByCap} deferred by the ${MAX_FETCHES} cap)` : '') +
      (opts.dryRun ? ' — DRY RUN, nothing written' : ''),
    );
    if (opts.dryRun) {
      stats.elapsedMs = Date.now() - t0;
      return stats;
    }

    await runPool(work, CONCURRENCY, async ({ key, url }) => {
      stats.attempted++;
      try {
        const r = await cacheAvatar(supabase, key, url);
        if (r.outcome === 'stored') {
          stats.stored++;
          stats.bytes += r.bytes;
        } else {
          stats.failed++;
          if (stats.failed <= 5) {
            console.warn(`  [warm] ${key}: ${r.outcome}${r.status ? ` (http ${r.status})` : ''}`);
          }
        }
      } catch (e: any) {
        // Log and continue: one bad avatar must never fail the run.
        stats.failed++;
        if (stats.failed <= 5) console.warn(`  [warm] ${key}: ${e?.message || e}`);
      }
    });
  } catch (e: any) {
    console.warn(`  [warm] aborted (non-fatal): ${e?.message || e}`);
  }

  stats.elapsedMs = Date.now() - t0;
  return stats;
}

export function formatWarmStats(s: WarmStats): string {
  return (
    `avatar warm: ${s.stored} stored, ${s.alreadyCached} already cached, ` +
    `${s.noLiveUrl} no live url, ${s.failed} failed` +
    (s.skippedByCap ? `, ${s.skippedByCap} deferred` : '') +
    ` (${(s.bytes / 1024).toFixed(0)} KiB in ${(s.elapsedMs / 1000).toFixed(1)}s)`
  );
}

/**
 * Standalone entry point: warm whatever the stored leaderboards currently show.
 * Used to warm today's payloads without waiting for the next nightly run.
 */
async function main() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const dryRun = process.argv.includes('--dry-run');
  const ti = process.argv.indexOf('--top');
  const topN = ti >= 0 ? Math.max(1, parseInt(process.argv[ti + 1], 10) || WARM_TOP_N_PER_PAYLOAD)
    : WARM_TOP_N_PER_PAYLOAD;

  const { data, error } = await supabase.from('creator_rankings').select('cache_key,payload');
  if (error) {
    console.error(`Cannot read creator_rankings: ${error.message}`);
    process.exit(1);
  }

  const targets = new Set<string>();
  for (const row of (data || []) as any[]) {
    for (const c of (row.payload || []).slice(0, topN)) {
      if (c?.creator_key) targets.add(c.creator_key);
    }
  }
  console.log(
    `Warming avatars for the top ${topN} of ${(data || []).length} stored payloads ` +
    `— ${targets.size} distinct creators.`,
  );

  const stats = await warmAvatars(supabase, [...targets], { dryRun });
  console.log(formatWarmStats(stats));
}

// Only run when invoked directly, not when imported by precompute-creators.
const invokedDirectly = process.argv[1]?.includes('warm-avatars');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
