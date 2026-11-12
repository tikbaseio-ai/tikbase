// CSV export of a product view (a preset, or the plain ranking for a niche and
// window). Pro only, enforced here from the bearer token: a free caller gets a
// 403 and no rows, whatever the client does.
//
// The file is the same rows the table shows, up to the stored top-400 of the
// ranking. Absent figures are empty cells, not 0 (see _lib/csv.ts).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveTier } from './_lib/resolve-tier.js';
import { isUpstreamOutage, unavailable } from './_lib/upstream.js';
import { isPresetId } from './_lib/presets.js';
import { parseRange } from './_lib/trend-math.js';
import { buildView, PRESET_WINDOW, type ViewRow } from './_lib/product-views.js';
import { toCsv } from './_lib/csv.js';

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const pct = (f: number | null | undefined) => (f == null ? null : Math.round(f * 1000) / 10);
const money = (n: number | null | undefined, ok = true) =>
  ok && n != null && n > 0 ? Math.round(n * 100) / 100 : null;

export function exportColumns(range: number, days: number) {
  const r = (row: ViewRow) => row as any;
  return [
    { header: 'rank', value: (_: ViewRow, i: number) => i + 1 },
    { header: 'product_id', value: (x: ViewRow) => x.product_id },
    { header: 'title', value: (x: ViewRow) => r(x).title },
    { header: 'shop', value: (x: ViewRow) => r(x).seller_name },
    { header: 'category', value: (x: ViewRow) => r(x).niche_label },
    { header: 'price_usd', value: (x: ViewRow) => money(r(x).sale_price) },
    { header: 'lifetime_units_sold', value: (x: ViewRow) => (r(x).sold_count > 0 ? r(x).sold_count : null) },
    { header: `est_units_${days}d`, value: (x: ViewRow) => (x.metrics as any)?.estPeriodUnitsSold ?? null },
    { header: `est_revenue_${days}d_usd`, value: (x: ViewRow) => money((x.metrics as any)?.estRevenue) },
    { header: `revenue_basis_${days}d`, value: (x: ViewRow) => (x.metrics?.hasRealDelta ? 'measured' : 'estimated') },
    { header: 'revenue_7d_usd', value: (x: ViewRow) => money(x.windows?.['7']?.revenue) },
    { header: 'revenue_30d_usd', value: (x: ViewRow) => money(x.windows?.['30']?.revenue) },
    { header: `units_last_${range}d`, value: (x: ViewRow) => x.trend?.units ?? null },
    { header: `units_prior_${range}d`, value: (x: ViewRow) => x.trend?.priorUnits ?? null },
    { header: `growth_${range}d_pct`, value: (x: ViewRow) => pct(x.trend?.growth) },
    { header: `trend_status_${range}d`, value: (x: ViewRow) => x.trend?.status ?? null },
    { header: `creators_${days}d`, value: (x: ViewRow) => x.distinct_creators ?? null },
    { header: `videos_${days}d`, value: (x: ViewRow) => (r(x).window_video_count ?? null) },
    { header: 'affiliate_video_share_pct', value: (x: ViewRow) => pct(x.affiliate_intensity) },
    { header: `views_${days}d`, value: (x: ViewRow) => (x.metrics as any)?.periodViews ?? null },
    { header: 'first_seen_by_tikbase', value: (x: ViewRow) => (x.created_at ? String(x.created_at).slice(0, 10) : null) },
    { header: 'tiktok_url', value: (x: ViewRow) => r(x).product_url },
  ];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const presetRaw = req.query.preset;
    const preset = presetRaw == null || presetRaw === '' ? null : presetRaw;
    if (preset != null && !isPresetId(preset)) return res.status(400).json({ error: 'Unknown preset' });
    const niche = String(req.query.niche ?? 'all');
    if (!/^[a-z0-9-]{1,40}$/.test(niche)) return res.status(400).json({ error: 'Invalid niche' });
    const days = parseInt(String(req.query.days ?? '30'), 10);
    if (![7, 14, 30, 90, 180, 365].includes(days)) return res.status(400).json({ error: 'Invalid days' });
    const range = parseRange(req.query.range ?? (preset ? 7 : 30), preset ? [7, 30] : undefined);
    if (!range) return res.status(400).json({ error: 'Invalid range' });

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);
    res.setHeader('Cache-Control', 'private, no-store');
    if (tier !== 'paid') {
      return res.status(403).json({ error: 'CSV export is a Pro feature', upgrade: true });
    }

    const view = await buildView(supabase, { niche, days, preset, range });
    if (!view) return res.status(404).json({ error: 'Rankings for this view are not ready yet' });

    const shownDays = preset ? PRESET_WINDOW : days;
    const cols = exportColumns(range, shownDays);
    const csv = toCsv(cols, view.rows);

    const stamp = new Date().toISOString().slice(0, 10);
    const name = `tikbase-${preset ?? 'top-products'}-${niche}-${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.status(200).send(csv);
  } catch (err: any) {
    console.error('export-products error:', err?.message);
    if (isUpstreamOutage(err)) {
      const u = unavailable();
      res.setHeader('Retry-After', u.retryAfter);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(u.status).json(u.body);
    }
    return res.status(500).json({ error: 'Export failed' });
  }
}
