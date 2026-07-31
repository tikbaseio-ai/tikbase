// Creator search — type-ahead over the 110k-row creator universe.
//
// Search itself is open to every tier: it is the hook, and a free user who
// cannot find a creator never discovers there is anything to unlock. What is
// tiered is the STATS attached to each hit. The free shape carries identity and
// a video count; the GMV-adjacent fields are not narrowed, they are ABSENT, so a
// free response cannot leak a number through a field a client forgot to hide.
//
// Ranking, escaping and the LIKE predicates live in search_creators() —
// migrations/manual/2026-07-30-creator-search.sql. Doing it in SQL is what lets
// the trigram indexes serve the query: measured 497ms -> 1.2ms warm, and the
// no-match case (every intermediate keystroke of a word that does not exist)
// 194ms -> 12ms.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveTier } from '../shared/resolve-tier';

const MIN_QUERY = 2;
const MAX_RESULTS = 20;

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---- Rate limiting -------------------------------------------------------
// An open text endpoint invites scraping, and every miss is a trigram lookup.
// A fixed window per IP is enough to stop a naive loop.
//
// HONEST LIMIT: this is per-instance memory. On Vercel each concurrent lambda
// keeps its own counter, so the effective ceiling is RATE_LIMIT_MAX x instances,
// and a cold start resets it. It is a courtesy brake on accidental hammering,
// NOT a security control — anything stronger needs shared state (Postgres or
// Upstash) and is a separate change.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd || '').split(',')[0];
  return (first || (req.socket as any)?.remoteAddress || 'unknown').trim();
}

function rateLimited(ip: string, now: number): boolean {
  const entry = hits.get(ip);
  if (!entry || now >= entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    // Opportunistic sweep so the map cannot grow without bound in a long-lived
    // instance. Cheap: only runs when a window rolls over.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const now = Date.now();
    const ip = clientIp(req);
    if (rateLimited(ip, now)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many searches, slow down' });
    }

    const q = String(req.query.q ?? '').trim();
    if (q.length < MIN_QUERY) {
      // Not an error — the client calls this on every keystroke. Return the
      // empty shape so the UI has nothing to special-case.
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.json({ results: [], query: q, tier: 'free', truncated: false });
    }

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);

    const { data, error } = await supabase.rpc('search_creators', {
      p_q: q,
      p_limit: MAX_RESULTS,
    });
    if (error) throw new Error(error.message);

    const rows = (data as any[]) || [];
    const results = rows.map((r) => {
      // Always proxied, never the raw CDN URL: those are signed and 403 within
      // about a day. /api/avatar serves cached bytes or a placeholder.
      const base = {
        creator_key: r.creator_key,
        display_name: r.display_name,
        handle: r.handle,
        avatar_url: `/api/avatar?key=${encodeURIComponent(r.creator_key)}`,
        videos_count: r.videos_count ?? 0,
      };
      if (tier === 'free') return base;
      return {
        ...base,
        products_count: r.products_count ?? 0,
        first_seen: r.first_seen ?? null,
        last_seen: r.last_seen ?? null,
      };
    });

    // Per-user (tiered) responses must never be shared by the CDN, which caches
    // by URL and ignores auth — an edge-cached Pro payload would leak to free
    // callers.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({
      results,
      query: q,
      tier,
      // The search deliberately caps at 20; say so rather than implying the
      // universe is this small.
      truncated: results.length === MAX_RESULTS,
    });
  } catch (err: any) {
    console.error('creator-search error:', err?.message);
    return res.status(500).json({ error: 'Search failed' });
  }
}
