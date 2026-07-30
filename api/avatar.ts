// Cache-through creator-avatar proxy.
//
// Same problem and same shape as api/thumb.ts: TikTok CDN avatar URLs are
// signed (`x-expires`, `x-signature`) and 403 once stale, so the avatar_url
// stored on `creators` goes dead within about a day and the leaderboard renders
// blank circles. This endpoint caches the bytes in Supabase Storage keyed by
// creator, so each avatar is fetched from TikTok at most once:
//   1. Storage hit  -> redirect to the permanent public URL (immutable cache).
//   2. Storage miss -> read creators.avatar_url, fetch the bytes, upload to
//      Storage, redirect to the stored URL.
//   3. Any failure  -> a neutral placeholder (never 500s the <img> tag).
//
// Keyed on creator_key rather than the URL because the key is stable while the
// signed URL rotates — caching by URL would store a new copy on every refresh.
//
// The storage layout and the write itself live in shared/avatar-cache.ts,
// shared with pipeline/warm-avatars.ts: the warmer caches these same objects
// nightly while the signed URLs are still fresh, which is the only moment the
// fetch can succeed. If the two derived different paths, warming would cache
// bytes this endpoint could never find.
//
// Usage: <img src="/api/avatar?key=<creator_key>">

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  AVATAR_BUCKET,
  AVATAR_PREFIX,
  avatarPublicUrl,
  avatarStorageName,
  cacheAvatar,
} from '../shared/avatar-cache';

function admin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Neutral dark circle-ish placeholder. Short cache so a later request retries.
function sendPlaceholder(res: VercelResponse) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    '<rect width="96" height="96" fill="#18181b"/>' +
    '<circle cx="48" cy="38" r="16" fill="#27272a"/>' +
    '<path d="M20 88c0-15 12.5-26 28-26s28 11 28 26z" fill="#27272a"/></svg>';
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Avatar-Source', 'placeholder');
  res.status(200).send(svg);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = String(req.query.key || '');
  if (!key || key.length > 128) return sendPlaceholder(res);

  let supabase;
  try {
    supabase = admin();
  } catch {
    return sendPlaceholder(res);
  }

  const name = avatarStorageName(key);
  const publicUrl = avatarPublicUrl(supabase, key);

  const redirectTo = (target: string, source: string, longCache: boolean) => {
    res.setHeader('X-Avatar-Source', source);
    res.setHeader(
      'Cache-Control',
      longCache
        ? 'public, max-age=86400, s-maxage=31536000, immutable'
        : 'public, max-age=3600',
    );
    res.setHeader('Location', target);
    res.status(302).end();
  };

  // 1. Storage hit? Single-key lookup — the cheap shape for one request.
  try {
    const { data: list } = await supabase.storage
      .from(AVATAR_BUCKET)
      .list(AVATAR_PREFIX, { limit: 1, search: name });
    if (list && list.some((f) => f.name === name)) {
      return redirectTo(publicUrl, 'storage', true);
    }
  } catch {
    /* fall through to miss path */
  }

  // 2. Miss -> resolve the current signed URL from creators, fetch, store.
  //    Expect this to fail for creators whose avatar_url has already lapsed;
  //    the nightly warmer is what catches them while the URL is still fresh.
  try {
    const { data: row, error } = await supabase
      .from('creators')
      .select('avatar_url')
      .eq('creator_key', key)
      .maybeSingle();
    const src = (row as any)?.avatar_url as string | undefined;
    if (error || !src) return sendPlaceholder(res);

    const result = await cacheAvatar(supabase, key, src);
    if (result.outcome === 'stored') return redirectTo(result.publicUrl, 'origin', true);
    if (result.outcome === 'upload-failed') {
      // Couldn't store it, but the signed URL is fresh right now — use it
      // directly with a short cache, since it will expire.
      return redirectTo(src, 'origin-nostore', false);
    }
    return sendPlaceholder(res);
  } catch {
    return sendPlaceholder(res);
  }
}
