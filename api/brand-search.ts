// Brand (seller) search — the third section of the global search box.
//
// Same posture as product and creator search: open to every tier, because a
// user who cannot find a brand never learns there is anything to unlock. There
// are no paid-only fields here — a brand hit is name, catalogue size and
// volume, all of which are already visible on the products page.
//
// Miss capture lives in api/product-search.ts and is driven by the client once
// ALL THREE sections come back empty; this endpoint never records anything.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const MIN_QUERY = 2;
const MAX_RESULTS = 20;
// Below this the trigram index has nothing to match on and the substring
// search reads the whole seller catalogue, so a shorter needle is served by
// the prefix function and its btree instead. Measured on 'an': p50 105ms ->
// 1.2ms, p95 5.8s -> 2.5ms.
const TRIGRAM_MIN = 3;

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Same courtesy brake as the sibling search endpoints: per-instance memory, so
// the real ceiling is RATE_LIMIT_MAX x instances. Not a security control.
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
    if (hits.size > 5000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (rateLimited(clientIp(req), Date.now())) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many searches, slow down' });
    }

    const q = String(req.query.q ?? '').trim();
    if (q.length < MIN_QUERY) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.json({ results: [], query: q, truncated: false });
    }

    const supabase = getAdminClient();
    const fn = q.length < TRIGRAM_MIN ? 'search_brands_prefix' : 'search_brands';
    const { data, error } = await supabase.rpc(fn, {
      p_q: q,
      p_limit: MAX_RESULTS,
    });
    if (error) throw new Error(error.message);

    const results = ((data as any[]) || []).map((r) => ({
      seller_id: r.seller_id,
      seller_name: r.seller_name,
      product_count: Number(r.product_count) || 0,
      total_sold: Number(r.total_sold) || 0,
      niches: Number(r.niches) || 0,
    }));

    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({ results, query: q, truncated: results.length === MAX_RESULTS });
  } catch (err: any) {
    console.error('brand-search error:', err?.message);
    return res.status(500).json({ error: 'Search failed' });
  }
}
