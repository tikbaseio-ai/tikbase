// Preset "opportunity" views over the stored product rankings: High Potential
// Affiliate, Rapid Growth, New to TikBase. Rows come out in the shape
// /api/top-products returns, so the products table renders them unchanged.
//
// Pro only (server-enforced; free gets a 403 with upgrade:true and no rows,
// because a preset applied to the free top-10 slice would be a meaningless
// result). Reads rankings_cache and product_snapshots; makes no vendor calls.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveTier } from './_lib/resolve-tier.js';
import { isUpstreamOutage, unavailable } from './_lib/upstream.js';
import { isPresetId } from './_lib/presets.js';
import { parseRange } from './_lib/trend-math.js';
import { buildView, PRESET_WINDOW } from './_lib/product-views.js';

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const preset = req.query.preset;
    if (!isPresetId(preset)) return res.status(400).json({ error: 'Unknown preset' });
    // Growth over 90 days would pull 400 products x 187 snapshots per request.
    const range = parseRange(req.query.range ?? 7, [7, 30]);
    if (!range) return res.status(400).json({ error: 'range must be 7 or 30 for presets' });
    const niche = String(req.query.niche ?? 'all');
    if (!/^[a-z0-9-]{1,40}$/.test(niche)) return res.status(400).json({ error: 'Invalid niche' });
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (tier !== 'paid') {
      return res.status(403).json({ error: 'Preset views are a Pro feature', upgrade: true });
    }

    const view = await buildView(supabase, { niche, days: PRESET_WINDOW, preset, range });
    if (!view) {
      // Not precomputed is not "no products match": the client must not render
      // an empty-result claim for it.
      return res.status(404).json({ error: 'Rankings for this niche are not ready yet' });
    }
    const offset = (page - 1) * limit;
    return res.json({
      products: view.rows.slice(offset, offset + limit),
      total: view.rows.length,
      page, limit, preset, range,
      days: PRESET_WINDOW,
      coverage: {
        pool: view.pool,
        evaluated: view.evaluated,
        unevaluated: view.unevaluated,
        trendUnreadable: view.trendFailed,
      },
      criteria: view.criteria,
    });
  } catch (err: any) {
    console.error('product-views error:', err?.message);
    if (isUpstreamOutage(err)) {
      const u = unavailable();
      res.setHeader('Retry-After', u.retryAfter);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(u.status).json(u.body);
    }
    return res.status(500).json({ error: 'Failed to load view' });
  }
}
