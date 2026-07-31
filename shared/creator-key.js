/**
 * creator-key.js — the single definition of a creator's identity key.
 *
 * Plain ESM JavaScript, not TypeScript, because the nightly pipeline entry point
 * (pipeline/tikbase-daily-refresh.js) runs under bare `node` and cannot import a
 * .ts module. The .d.ts alongside gives the TypeScript callers their types.
 *
 * Four call sites need this rule and a divergence between any two of them
 * silently splits one creator into several:
 *   - the write path (pipeline/tikbase-daily-refresh.js, discover-videos.js),
 *     which stamps creator_key at insert time,
 *   - the aggregation (pipeline/precompute-creators.ts),
 *   - the avatar warmer (pipeline/warm-avatars.ts),
 *   - the SQL backfill expression in migrations/manual/2026-07-28-creators.sql.
 */

// MUST stay identical to the backfill expression in the migration — this is the
// same rule expressed twice.
//
// 'user' is phase 1's placeholder for a missing unique_id, not an identity, so
// it yields null rather than collapsing those videos into one fake creator.
const URL_HANDLE = /tiktok\.com\/@([^/?#]+)\/video\//i;

/**
 * @param {string | null | undefined} videoUrl
 * @returns {string | null}
 */
export function deriveCreatorKey(videoUrl) {
  const m = URL_HANDLE.exec(videoUrl || '');
  if (!m) return null;
  const h = m[1];
  if (h === 'user') return null;
  return /^[0-9]{6,}$/.test(h) ? `id:${h}` : h.toLowerCase();
}
