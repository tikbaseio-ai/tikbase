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
// Usage: <img src="/api/avatar?key=<creator_key>">

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'thumbnails'; // reuse the existing bucket; distinct path prefix
const IMG_TIMEOUT_MS = 8000;

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

async function fetchWithTimeout(url: string, ms: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// creator_key is 'lower(handle)' or 'id:<digits>'. Flatten to a filesystem-safe
// name; the charset is already constrained by the migration's derivation.
function storageName(creatorKey: string): string {
  return creatorKey.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120);
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

  const name = `${storageName(key)}.jpg`;
  const path = `avatars/${name}`;
  const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

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

  // 1. Storage hit?
  try {
    const { data: list } = await supabase.storage
      .from(BUCKET)
      .list('avatars', { limit: 1, search: name });
    if (list && list.some((f) => f.name === name)) {
      return redirectTo(publicUrl, 'storage', true);
    }
  } catch {
    /* fall through to miss path */
  }

  // 2. Miss -> resolve the current signed URL from creators, fetch, store.
  try {
    const { data: row, error } = await supabase
      .from('creators')
      .select('avatar_url')
      .eq('creator_key', key)
      .maybeSingle();
    const src = (row as any)?.avatar_url as string | undefined;
    if (error || !src) return sendPlaceholder(res);

    const img = await fetchWithTimeout(src, IMG_TIMEOUT_MS);
    if (!img.ok) return sendPlaceholder(res);
    const buf = Buffer.from(await img.arrayBuffer());
    const contentType = img.headers.get('content-type') || 'image/jpeg';

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buf, { contentType, upsert: true, cacheControl: '31536000' });

    if (upErr) {
      // Couldn't store it, but the signed URL is fresh right now — use it
      // directly with a short cache, since it will expire.
      return redirectTo(src, 'origin-nostore', false);
    }
    return redirectTo(publicUrl, 'origin', true);
  } catch {
    return sendPlaceholder(res);
  }
}
