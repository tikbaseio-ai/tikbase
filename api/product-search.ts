// Product search — the reviewer's top ask: find a product, then go straight to
// the videos already working for it.
//
// Mirrors api/creator-search.ts deliberately: same tier posture (everyone may
// search, because a user who cannot find a product never discovers there is
// anything to unlock), same rate limit shape, same "absent, not narrowed"
// treatment of paid fields, same private cache header.
//
// Ranking, escaping and the LIKE predicates live in search_products() —
// migrations/manual/2026-07-31-product-search.sql — which is what lets the
// trigram indexes serve the query.
//
// The one thing this has that creator search does not: MISS CAPTURE. A search
// returning nothing is a user telling us which product they expected us to
// cover, so it is recorded rather than discarded.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveTier, type Tier } from './_lib/resolve-tier.js';

const MIN_QUERY = 2;
const MAX_RESULTS = 20;
/** Do not store absurd input; the queue is a demand signal, not a log sink. */
const MAX_RECORDED_QUERY = 200;

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---- Rate limiting -------------------------------------------------------
// Same honest limit as creator-search: per-instance memory, so the real ceiling
// is RATE_LIMIT_MAX x instances and a cold start resets it. A courtesy brake on
// accidental hammering, NOT a security control.
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
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    }
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

/**
 * Record a zero-result search.
 *
 * Deliberately not awaited by the response path and deliberately swallowing its
 * own errors: a full queue, a permissions problem or a slow insert must never
 * turn a working search into a failed request. The signal is valuable, the
 * response is more valuable.
 */
function recordMiss(supabase: SupabaseClient, q: string, tier: Tier): void {
  void supabase
    .from('search_misses')
    .insert({ kind: 'product', query: q.slice(0, MAX_RECORDED_QUERY), user_tier: tier })
    .then(({ error }) => {
      if (error) console.warn('search_misses insert failed:', error.message);
    });
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

    // Miss-recording flags, for the combined header search.
    //
    //   suppress_miss=1  run the search, record nothing. The caller is also
    //                    searching creators and does not yet know whether the
    //                    user found anything.
    //   report_miss=1    record the miss and return immediately. The caller has
    //                    now seen BOTH sides come back empty.
    //
    // Without this, typing a creator's name into the combined box would log a
    // phantom "missing product" on every keystroke and drown the real signal.
    const suppressMiss = String(req.query.suppress_miss ?? '') === '1';
    const reportMiss = String(req.query.report_miss ?? '') === '1';

    if (reportMiss) {
      if (q.length < MIN_QUERY) return res.status(204).end();
      const supabase = getAdminClient();
      const tier = await resolveTier(req, supabase);
      recordMiss(supabase, q, tier);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ recorded: true, query: q });
    }

    if (q.length < MIN_QUERY) {
      // Not an error — the client calls this on every keystroke. Return the
      // empty shape so the UI has nothing to special-case. Not recorded as a
      // miss either: "b" is a person still typing, not an unmet need.
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.json({ results: [], query: q, tier: 'free', truncated: false });
    }

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);

    const { data, error } = await supabase.rpc('search_products', {
      p_q: q,
      p_limit: MAX_RESULTS,
    });
    if (error) throw new Error(error.message);

    const rows = (data as any[]) || [];
    if (rows.length === 0 && !suppressMiss) recordMiss(supabase, q, tier);

    const results = rows.map((r) => {
      // Thumbnails always go through the proxy. 7,591 of 48,706 product images
      // are signed CDN URLs that 403 once stale — the same failure the avatar
      // proxy already solves — so serving image_url directly would show broken
      // images for one product in six.
      const base = {
        product_id: r.product_id,
        title: r.title,
        seller_name: r.seller_name ?? null,
        image_url: `/api/thumb?product_id=${encodeURIComponent(r.product_id)}`,
        sale_price: r.sale_price == null ? null : Number(r.sale_price),
        sold_count: Number(r.sold_count) || 0,
        niche_slug: r.niche_slug ?? null,
        has_ranking_data: r.has_ranking_data === true,
      };
      if (tier === 'free') return base;
      return {
        ...base,
        est_revenue_30d:
          r.est_revenue_30d == null ? null : Number(r.est_revenue_30d),
      };
    });

    // Per-user (tiered) responses must never be shared by the CDN, which caches
    // by URL and ignores auth.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({
      results,
      query: q,
      tier,
      truncated: results.length === MAX_RESULTS,
    });
  } catch (err: any) {
    console.error('product-search error:', err?.message);
    return res.status(500).json({ error: 'Search failed' });
  }
}
