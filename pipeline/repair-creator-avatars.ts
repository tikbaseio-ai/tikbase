/**
 * repair-creator-avatars.ts — re-fetch avatars whose signed URL died before
 * anything cached it.
 *
 * The nightly warmer (warm-avatars.ts) catches an avatar while its URL is still
 * signed, which fixes the problem going forward but cannot reach back: a URL
 * that expired days ago is gone, and no amount of retrying the stored value will
 * return bytes. On 2026-07-30 that was the state of the whole leaderboard —
 * zero of 109,737 stored avatar_urls were inside their signed window — and it hit
 * the top of the board hardest, because the highest-GMV creators are the ones
 * whose videos were discovered longest ago.
 *
 * This is the only path that repairs those: ask ScrapeCreators for the creator's
 * current profile, which returns a freshly-signed avatar URL, then cache the
 * bytes through the same shared/avatar-cache path everything else uses and write
 * the fresh URL back to `creators`.
 *
 * UNLIKE every other creator script, THIS ONE SPENDS CREDITS — one per creator
 * repaired. So it is opt-in, bounded by --limit, and reports what it charged.
 * It is not wired into the nightly job.
 *
 * Usage:
 *   tsx --env-file=.env pipeline/repair-creator-avatars.ts               # free top 5 of all:30
 *   tsx --env-file=.env pipeline/repair-creator-avatars.ts --top 50 --limit 50
 *   tsx --env-file=.env pipeline/repair-creator-avatars.ts --dry-run     # no calls, no credits
 */
import { createClient } from '@supabase/supabase-js';
import { avatarStorageName, cacheAvatar, listCachedAvatars } from '../shared/avatar-cache';

const API_BASE = 'https://api.scrapecreators.com';
const RATE_LIMIT_MS = 250;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const scKey = process.env.SCRAPECREATORS_API_KEY;
if (!url || !key) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  if (i < 0) return dflt;
  const n = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const strOf = (flag: string, dflt: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * creator_key is 'lower(handle)' or 'id:<digits>'. The digits come from an
 * @<digits> handle in the video URL, which TikTok accepts as a profile handle,
 * so both forms are queryable.
 */
function handleFor(creatorKey: string, handle: string | null): string {
  if (handle) return handle;
  return creatorKey.startsWith('id:') ? creatorKey.slice(3) : creatorKey;
}

interface ProfileResult {
  avatarUrl: string | null;
  displayName: string | null;
  creditsCharged: number;
  creditsRemaining: number | null;
  status: number;
}

async function fetchProfile(handle: string): Promise<ProfileResult> {
  const path = `/v1/tiktok/profile?handle=${encodeURIComponent(handle)}`;
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-api-key': scKey as string } });
  const body: any = await res.json().catch(() => null);
  const user = body?.user || {};
  return {
    // Prefer the 720px copy: it is the size the 32px <img> is served from
    // elsewhere, and avatarLarger is 1080px for no benefit here.
    avatarUrl: user.avatarMedium || user.avatarLarger || user.avatarThumb || null,
    displayName: user.nickname || null,
    creditsCharged: Number(body?.credits_charged) || 0,
    creditsRemaining:
      body?.credits_remaining === undefined ? null : Number(body.credits_remaining),
    status: res.status,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const top = argOf('--top', 5);
  const limit = argOf('--limit', 5);
  const niche = strOf('--niche', 'all');
  const days = argOf('--days', 30);
  const cacheKey = `creators:${niche}:${days}`;

  if (!dryRun && !scKey) {
    console.error('Missing SCRAPECREATORS_API_KEY (required unless --dry-run)');
    process.exit(1);
  }

  const { data: row, error } = await supabase
    .from('creator_rankings')
    .select('payload,computed_at')
    .eq('cache_key', cacheKey)
    .maybeSingle();
  if (error || !row) {
    console.error(`Cannot read ${cacheKey}: ${error?.message ?? 'no row'}`);
    process.exit(1);
  }
  const payload = ((row as any).payload || []) as any[];
  const targets = payload.slice(0, top);
  console.log(
    `${cacheKey} (computed ${(row as any).computed_at}) — repairing the top ${top}, ` +
    `max ${limit} credit${limit === 1 ? '' : 's'}${dryRun ? ' — DRY RUN, no calls' : ''}`,
  );

  const listing = await listCachedAvatars(supabase);
  if (!listing.complete) {
    // This script spends credits, so never guess: an incomplete listing would
    // make already-cached creators look broken and buy their avatars again.
    console.error(`Storage listing incomplete (${listing.error}) — refusing to spend credits on a guess.`);
    process.exit(1);
  }
  const missing = targets.filter((c) => !listing.files.has(avatarStorageName(c.creator_key)));
  console.log(
    `  ${targets.length - missing.length}/${targets.length} already cached; ` +
    `${missing.length} to repair`,
  );
  if (missing.length === 0) return;

  let spent = 0;
  let stored = 0;
  let failed = 0;
  let remaining: number | null = null;

  for (const c of missing) {
    if (spent >= limit) {
      console.log(`  [stop] credit limit ${limit} reached; ${missing.length - spent} left unrepaired`);
      break;
    }
    const h = handleFor(c.creator_key, c.handle ?? null);
    if (dryRun) {
      console.log(`  would call /v1/tiktok/profile?handle=${h} for ${c.creator_key}`);
      continue;
    }

    try {
      const p = await fetchProfile(h);
      spent += p.creditsCharged;
      if (p.creditsRemaining !== null) remaining = p.creditsRemaining;
      if (p.status !== 200 || !p.avatarUrl) {
        failed++;
        console.warn(`  ✗ ${c.creator_key} (@${h}): http ${p.status}, no avatar in response`);
        continue;
      }

      const result = await cacheAvatar(supabase, c.creator_key, p.avatarUrl);
      if (result.outcome !== 'stored') {
        failed++;
        console.warn(`  ✗ ${c.creator_key}: ${result.outcome}${result.status ? ` (http ${result.status})` : ''}`);
        continue;
      }
      stored++;

      // Write the fresh URL back so the request-time miss path has something
      // live to work with too, and so the next aggregate carries it forward.
      const { error: upErr } = await supabase
        .from('creators')
        .update({ avatar_url: p.avatarUrl })
        .eq('creator_key', c.creator_key);
      console.log(
        `  ✓ ${c.creator_key} (@${h}) — ${result.bytes} B ${result.contentType}` +
        `${upErr ? ` [creators.avatar_url update failed: ${upErr.message}]` : ''}`,
      );
    } catch (e: any) {
      failed++;
      console.warn(`  ✗ ${c.creator_key} (@${h}): ${e?.message || e}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(
    `\nRepair done: ${stored} stored, ${failed} failed` +
    `\n  ScrapeCreators credits charged: ${spent}` +
    `${remaining !== null ? `\n  credits remaining: ${remaining}` : ''}`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
