// One product, and — the actual point of the page — the videos already working
// for it. The reviewer's ask verbatim: "search a product, go straight to the
// viral videos for that exact product so people can copy what's already
// working."
//
// Everything is read for one product, so it is index-served and cheap; there is
// no cache table here for the same reason api/creator-profile.ts has none.
//
// GMV is never computed per request. It is read from product_revenue_30d, which
// the nightly precompute fills from the 30-day payloads, and OMITTED when the
// product is not ranked — omitted, not zeroed, because "$0" asserts the product
// sold nothing, which is a different and false claim from "we have no figure".

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveTier } from '../shared/resolve-tier';

// Free tier sees enough videos to understand the format, then the upsell.
// Enforced HERE so ?limit= cannot widen it.
const FREE_VIDEOS = 3;
const DEFAULT_VIDEOS = 24;
const MAX_VIDEOS = 60;

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
    const id = String(req.query.id ?? '').trim();
    if (!id || id.length > 64) {
      return res.status(400).json({ error: 'Missing or invalid product id' });
    }

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);

    const requested = Math.min(
      MAX_VIDEOS,
      Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_VIDEOS), 10) || DEFAULT_VIDEOS),
    );
    // Ask the database for the full set even on free, so `videosTotal` can be
    // honest about how many exist while the response only carries three.
    const { data, error } = await supabase.rpc('product_detail', {
      p_product_id: id,
      p_video_limit: requested,
    });
    if (error) throw new Error(error.message);

    const detail = data as any;
    // A missing product is a 404 with a stable shape, not a 500 and not an empty
    // 200 the UI would render as a blank page.
    if (!detail?.product) {
      return res.status(404).json({ error: 'Product not found', id });
    }

    const p = detail.product;
    const allVideos = (detail.videos || []) as any[];
    const videos = tier === 'free' ? allVideos.slice(0, FREE_VIDEOS) : allVideos;
    const totals = detail.totals || {};
    const rev = detail.revenue30d || null;

    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({
      product: {
        product_id: p.product_id,
        title: p.title,
        seller_name: p.seller_name ?? null,
        seller_tiktok_url: p.seller_tiktok_url ?? null,
        product_url: p.product_url ?? null,
        niche_slug: p.niche_slug ?? null,
        niche_label: p.niche_label ?? null,
        // Proxied: 7,591 of 48,706 product images are signed CDN URLs that 403
        // once stale, so the raw value shows a broken image for one product in
        // six.
        image_url: `/api/thumb?product_id=${encodeURIComponent(p.product_id)}`,
        sale_price: p.sale_price == null ? null : Number(p.sale_price),
        original_price: p.original_price == null ? null : Number(p.original_price),
        sold_count: Number(p.sold_count) || 0,
        // 0 stock is indistinguishable from "not reported" — 46,195 of 47,962
        // products report 0 — so it is null here rather than a claim of sold out.
        stock_quantity: Number(p.stock_quantity) > 0 ? Number(p.stock_quantity) : null,
        rating: p.rating == null ? null : Number(p.rating),
        review_count: Number(p.review_count) || 0,
        first_seen: p.created_at ?? null,
      },
      windows: {
        7: detail.windows?.['7'] ?? null,
        30: detail.windows?.['30'] ?? null,
      },
      totals: {
        videos: Number(totals.videos) || 0,
        creators: Number(totals.creators) || 0,
        views: Number(totals.views) || 0,
      },
      // Absent for two reasons, both rendering an em dash: the product is in no
      // 30-day payload, or the caller is free. Free omits the field entirely
      // rather than sending a narrowed number, same rule as product-search.
      ...(rev && tier === 'paid'
        ? {
            gmv: {
              estRevenue: Number(rev.estRevenue) || 0,
              hasRealDelta: rev.hasRealDelta === true,
              days: 30,
            },
          }
        : {}),
      videos: videos.map((v) => ({
        video_id: v.video_id ?? null,
        video_url: v.video_url ?? null,
        creator_key: v.creator_key ?? null,
        author_name: v.author_name ?? null,
        // Through the avatar proxy, which serves cached bytes or a placeholder —
        // never a raw signed URL that 403s.
        avatar_url: v.creator_key
          ? `/api/avatar?key=${encodeURIComponent(v.creator_key)}`
          : null,
        view_count: Number(v.view_count) || 0,
        like_count: Number(v.like_count) || 0,
        commissioned: v.commissioned === true,
        posted_at: v.posted_at ?? null,
      })),
      videosTotal: Number(totals.videos) || 0,
      videosShown: videos.length,
      tier,
    });
  } catch (err: any) {
    console.error('product-detail error:', err?.message);
    return res.status(500).json({ error: 'Failed to load product' });
  }
}
