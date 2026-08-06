// One brand (TikTok Shop seller) and everything it sells.
//
// Mirrors api/creator-profile.ts deliberately — same tier posture, same 404
// shape, same private cache header, same "omit rather than zero" rule for GMV.
// A brand is not a table: `products` carries seller_id on 47,408 of 51,963 rows
// (18,567 distinct sellers), so the profile is a GROUP BY behind an index.
//
// Reads product_revenue_30d, the materialised lookup the nightly precompute
// fills. It never reads or writes rankings_cache, so it is safe to run while a
// recompute is in flight.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveTier } from '../shared/resolve-tier';

// Free sees enough to judge the brand, then the upsell. Enforced HERE so
// ?limit= and ?page= cannot widen it.
const FREE_PRODUCTS = 3;
const DEFAULT_PRODUCTS = 25;
const MAX_PRODUCTS = 100;

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
    const raw = String(req.query.seller_id ?? '').trim();
    // 'name:<shop>' is the second address form. The products leaderboard is
    // rendered from rankings_cache payloads, which carry seller_name but no
    // seller_id, so its rows link by name and are resolved here rather than
    // forcing a payload rebuild. Names are longer than ids, hence the wider cap.
    const byName = raw.startsWith('name:');
    if (!raw || raw.length > (byName ? 261 : 64)) {
      return res.status(400).json({ error: 'Missing or invalid seller_id' });
    }

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);

    let sellerId = raw;
    if (byName) {
      const { data: resolved, error: resolveErr } = await supabase.rpc('brand_id_for_name', {
        p_name: raw.slice(5),
      });
      if (resolveErr) throw new Error(resolveErr.message);
      // An unknown shop name is the same 404 as an unknown id — the caller
      // should not have to care which form it used.
      if (!resolved) return res.status(404).json({ error: 'Brand not found', seller_id: raw });
      sellerId = String(resolved);
    }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const requested = Math.min(
      MAX_PRODUCTS,
      Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_PRODUCTS), 10) || DEFAULT_PRODUCTS),
    );
    const limit = tier === 'free' ? FREE_PRODUCTS : requested;
    const offset = tier === 'free' ? 0 : (page - 1) * limit;

    const [profileRes, productsRes] = await Promise.all([
      supabase.rpc('brand_profile', { p_seller_id: sellerId }),
      supabase.rpc('brand_products', {
        p_seller_id: sellerId,
        p_limit: limit,
        p_offset: offset,
      }),
    ]);

    if (profileRes.error) throw new Error(profileRes.error.message);
    const b = profileRes.data as any;
    // An unknown seller is a 404 with a stable shape, not an empty 200 the UI
    // would render as a blank brand.
    if (!b) return res.status(404).json({ error: 'Brand not found', seller_id: sellerId });

    if (productsRes.error) throw new Error(productsRes.error.message);
    const rows = (productsRes.data as any[]) || [];
    const total = rows.length ? Number(rows[0].total_count) || 0 : 0;

    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({
      brand: {
        seller_id: b.seller_id,
        seller_name: b.seller_name ?? null,
        seller_tiktok_url: b.seller_tiktok_url ?? null,
        product_count: Number(b.product_count) || 0,
        total_sold: Number(b.total_sold) || 0,
        niches: Array.isArray(b.niches) ? b.niches : [],
        first_seen: b.first_seen ?? null,
        // Paid-only, and absent rather than zeroed for free: "$0" would assert
        // the brand sold nothing, which is a different claim from "we are not
        // showing you the figure".
        ...(tier === 'paid' && b.revenue_30d
          ? {
              revenue30d: {
                estRevenue: Number(b.revenue_30d.est_revenue) || 0,
                products: Number(b.revenue_30d.products) || 0,
                measured: Number(b.revenue_30d.measured) || 0,
              },
            }
          : {}),
      },
      products: rows.map((p) => ({
        product_id: p.product_id,
        title: p.title,
        niche_slug: p.niche_slug ?? null,
        // Proxied: 7,591 of the catalogue's images are signed CDN URLs that 403
        // once stale, so the raw value breaks for one product in six.
        image_url: `/api/thumb?product_id=${encodeURIComponent(p.product_id)}`,
        sale_price: p.sale_price == null ? null : Number(p.sale_price),
        sold_count: Number(p.sold_count) || 0,
        // 0 stock is indistinguishable from "not reported" for 96% of the
        // catalogue, so it is null rather than a claim of sold out.
        stock_quantity: Number(p.stock_quantity) > 0 ? Number(p.stock_quantity) : null,
        // Absent when the product is not ranked, or when the caller is free.
        // Omitted rather than zeroed: "$0" asserts it sold nothing, which is a
        // different and false claim from "we have no figure".
        ...(tier === 'paid' && p.est_revenue_30d != null
          ? {
              gmv30d: {
                estRevenue: Number(p.est_revenue_30d) || 0,
                hasRealDelta: p.has_real_delta === true,
              },
            }
          : {}),
      })),
      productsTotal: total,
      productsPage: tier === 'free' ? 1 : page,
      productsLimit: limit,
      tier,
    });
  } catch (err: any) {
    console.error('brand-profile error:', err?.message);
    return res.status(500).json({ error: 'Failed to load brand' });
  }
}
