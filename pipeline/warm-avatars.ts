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
 * api/avatar reads (api/_lib/avatar-cache.ts).
 *
 * Costs ZERO ScrapeCreators credits: these are plain CDN image fetches plus
 * Supabase Storage writes. It never throws and never fails the run — a cold
 * avatar cache degrades to a placeholder, which is not worth losing a
 * leaderboard over.
 *
 * URL SOURCING. `creators.avatar_url` is copied in at aggregation time and is
 * usually already stale, so this does not trust it as the only source. The
 * freshest signed URL for a creator is whatever the most recently inserted
 * `product_videos` row carries, so those rows win over the aggregate and the
 * aggregate is only a fallback.
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
} from '../api/_lib/avatar-cache.js';

/** How deep into each niche x window payload to warm. The page shows 50/page. */
export const WARM_TOP_N_PER_PAYLOAD = 50;
/** Bounded in-flight CDN fetches — same ceiling the other pipeline jobs use. */
const CONCURRENCY = 8;
/** Re-fetch an avatar at most this often; faces change rarely. */
const RECACHE_AFTER_DAYS = 7;
const PAGE = 1000;
/** creator_keys per `in (...)` filter — keeps the request URL a sane length. */
const KEY_CHUNK = 200;
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
 * A targeted read of just the render set's rows, served by
 * idx_product_videos_creator_key. This is only possible because creator_key is
 * now stamped at insert time by every write path (shared/creator-key.js) and the
 * pre-existing gap was backfilled by pipeline/backfill-creator-keys.js. Before
 * that, the rows carrying live signatures were exactly the unkeyed ones, and
 * finding them meant a full 346k-row pass — ~9 minutes — because `creator_key is
 * null` is not index-served (the index is partial on the not-null rows) and
 * created_at is unindexed, so ordering by it cancels on statement timeout.
 *
 * Pagination stays on `id` within each chunk: `id` is a random uuid, so it
 * carries no recency, but it is the PK and therefore a stable cursor.
 */
async function loadFreshUrls(
  supabase: SupabaseClient,
  wanted: Set<string>,
  now: number,
): Promise<Map<string, string>> {
  const best = new Map<string, { url: string; exp: number }>();
  const keys = [...wanted];
  let scanned = 0;

  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK);
    let last = '';
    for (;;) {
      let q = supabase
        .from('product_videos')
        .select('id,creator_key,author_avatar_url')
        .in('creator_key', chunk)
        .not('author_avatar_url', 'is', null)
        .order('id', { ascending: true })
        .limit(PAGE);
      if (last) q = q.gt('id', last);
      const { data, error } = await q;
      if (error) {
        // Partial results are still useful: warm what we found and move on.
        console.warn(`  [warm] fresh-url read stopped early: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      scanned += data.length;

      for (const r of data as any[]) {
        const key = r.creator_key as string;
        const url = r.author_avatar_url as string;
        if (!key || !isSignedUrlLive(url, now)) continue;
        // Furthest expiry wins. An unsigned URL has nothing to compare, so treat
        // it as barely-live: any real signature outranks it.
        const exp = signedUrlExpiryMs(url) ?? now + 1;
        const prev = best.get(key);
        if (!prev || exp > prev.exp) best.set(key, { url, exp });
      }

      last = (data[data.length - 1] as any).id;
      if (data.length < PAGE) break;
    }
  }

  console.log(`  [warm] read ${scanned} video rows, ${best.size} targets have a live url`);
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
    const listing = await listCachedAvatars(supabase);
    if (!listing.complete) {
      // Say so out loud: an incomplete listing makes already-cached avatars look
      // uncached, and the run below will re-fetch bytes it already has.
      console.warn(
        `  [warm] storage listing incomplete (${listing.error}); ` +
        `treating ${listing.files.size} known objects as the full set`,
      );
    }
    const cached = listing.files;
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
