// Sales trend and growth for a set of products, read from the daily snapshots.
//
// Pro only. The trend is a paid number, so for a free caller it is OMITTED from
// the response (an empty map), not narrowed or zeroed, and the tier comes from
// the bearer token, never a query param. A free caller is answered, not 401'd,
// like every other data endpoint here.
//
// Coverage is part of the answer: each product carries `status` and
// `historyDays`, so a product we have snapshots for over 12 days says
// 'short-history' for a 30 day range instead of a growth figure we cannot back.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveTier } from './_lib/resolve-tier.js';
import { loadTrends } from './_lib/trend-store.js';
import { parseRange } from './_lib/trend-math.js';

const MAX_IDS = 100;

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
    const range = parseRange(req.query.range ?? 30);
    if (!range) return res.status(400).json({ error: 'range must be 7, 30 or 90' });

    const ids = Array.from(
      new Set(
        String(req.query.ids ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^\d{5,30}$/.test(s)),
      ),
    ).slice(0, MAX_IDS);
    if (!ids.length) return res.status(400).json({ error: 'ids required' });

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (tier !== 'paid') return res.json({ tier, range, trends: {} });

    // `detail` adds per-day revenue and gap length - the product page chart
    // needs them, a sparkline does not, and 50 rows x 90 points adds up.
    const detail = req.query.detail === '1';
    const { trends, failed } = await loadTrends(supabase, ids, range);
    const out: Record<string, unknown> = {};
    for (const [id, t] of trends) {
      out[id] = {
        status: t.status, asOf: t.asOf, historyDays: t.historyDays,
        units: t.units, priorUnits: t.priorUnits, growth: t.growth,
        points: detail ? t.points : t.points.map((p) => ({ d: p.d, u: p.u })),
      };
    }
    // A chunk that failed is absent from `trends`; say so, because absent is
    // "could not read" and must not render as "no history".
    return res.json({ tier, range, trends: out, unreadable: failed });
  } catch (err: any) {
    console.error('product-trends error:', err?.message);
    return res.status(500).json({ error: 'Failed to load trends' });
  }
}
