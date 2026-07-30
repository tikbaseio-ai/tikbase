/**
 * creator-key.ts — the single definition of a creator's identity key.
 *
 * Lives in shared/ because three call sites need it and a divergence between any
 * two of them silently splits one creator into several: the aggregation
 * (pipeline/precompute-creators.ts), the avatar warmer (pipeline/warm-avatars.ts,
 * which must derive keys for rows the migration's one-time backfill never saw),
 * and the SQL backfill expression in
 * migrations/manual/2026-07-28-creators.sql.
 */

// MUST stay identical to the backfill expression in the migration — this is the
// same rule expressed twice.
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
