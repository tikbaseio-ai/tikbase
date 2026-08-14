// One creator's profile: identity, windowed stats, their products, their videos.
//
// Stats are computed LIVE from product_videos for this creator only, because a
// single-creator read is index-served and cheap — measured 11ms warm for the
// profile RPC and 1.4ms for the paginated products, against a creator with 220
// videos across 122 products. That is the whole reason there is no cache table
// here: the leaderboard needs one because it aggregates 346k rows, and this
// does not.
//
// GMV is the exception. It is a MODELLED attribution over ranked products and
// costs minutes to compute, so it is never computed per request — it is read out
// of the nightly creator_rankings payloads if this creator appears in one, and
// OMITTED otherwise. Omitted, not zeroed: "$0" would read as "sold nothing",
// which is a different and false claim.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveTier } from './_lib/resolve-tier.js';

// Free tier sees the first few products, then the upsell. Enforced HERE, not in
// the UI, so ?limit= and ?page= cannot widen the response.
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

interface GmvEntry {
  attributedGmv: number;
  gmvConfidence: number;
  niche: string;
  days: number;
}

/**
 * This creator's modelled GMV, extracted from the nightly payloads BY THE
 * DATABASE (creator_gmv()). Doing the find in Node instead means transferring
 * all 38 payloads — 400 enriched creators each — to read two numbers, which
 * measured 3.3s end to end against 10.7ms for the SQL version.
 *
 * Returns null when the creator is in no payload, which is the common case: the
 * payloads store the top 400 per niche/window and there are 110k creators.
 */
async function readGmv(
  supabase: SupabaseClient,
  key: string,
  days: number,
): Promise<GmvEntry | null> {
  const { data, error } = await supabase.rpc('creator_gmv', {
    p_key: key,
    p_days: days,
  });
  if (error || !data) return null;
  const g = data as any;
  return {
    attributedGmv: Number(g.attributedGmv) || 0,
    gmvConfidence: Number(g.gmvConfidence) || 0,
    niche: String(g.niche ?? 'all'),
    days: Number(g.days) || days,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const key = String(req.query.key ?? '').trim();
    if (!key || key.length > 128) {
      return res.status(400).json({ error: 'Missing or invalid creator key' });
    }

    const supabase = getAdminClient();
    const tier = await resolveTier(req, supabase);

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const requested = Math.min(
      MAX_PRODUCTS,
      Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_PRODUCTS), 10) || DEFAULT_PRODUCTS),
    );
    // Free tier is pinned to the first N products regardless of what is asked.
    const limit = tier === 'free' ? FREE_PRODUCTS : requested;
    const offset = tier === 'free' ? 0 : (page - 1) * limit;

    // All three reads in flight together — they are independent, and the page
    // waits for the slowest, not the sum.
    const [profileRes, productsRes, gmv] = await Promise.all([
      supabase.rpc('creator_profile', { p_key: key }),
      supabase.rpc('creator_products', {
        p_key: key,
        p_limit: limit,
        p_offset: offset,
      }),
      // GMV only for the 30d window — the one the stat cards show, and the only
      // window free tier ever sees on the leaderboard.
      readGmv(supabase, key, 30),
    ]);

    if (profileRes.error) throw new Error(profileRes.error.message);
    const profile = profileRes.data as any;

    // A key with no creator row is a 404 with a stable shape, not a 500 and not
    // an empty 200 the UI would render as a blank profile.
    if (!profile?.creator) {
      return res.status(404).json({ error: 'Creator not found', key });
    }

    if (productsRes.error) throw new Error(productsRes.error.message);
    const productRows = (productsRes.data as any[]) || [];
    const totalProducts = productRows.length ? Number(productRows[0].total_count) || 0 : 0;

    const c = profile.creator;
    const windows = profile.windows || {};

    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json({
      creator: {
        creator_key: c.creator_key,
        display_name: c.display_name,
        handle: c.handle,
        author_id: c.author_id,
        // Numeric-key creators have no handle, so there is no profile URL to
        // link out to. Null rather than a fabricated @id: link.
        tiktok_url: c.handle ? `https://www.tiktok.com/@${c.handle}` : null,
        avatar_url: `/api/avatar?key=${encodeURIComponent(c.creator_key)}`,
        first_seen: c.first_seen,
        last_seen: c.last_seen,
        videos_count: c.videos_count ?? 0,
        products_count: c.products_count ?? 0,
      },
      windows: {
        7: windows['7'] ?? null,
        30: windows['30'] ?? null,
      },
      lifetimeViews: Number(profile.lifetimeViews) || 0,
      // Absent for two different reasons, and the UI renders an em dash for
      // both: the creator is in no nightly payload, or the caller is free.
      // Free omits the field entirely rather than sending a narrowed number —
      // same rule as creator-search, so a number cannot leak through a field a
      // client forgot to hide. The free leaderboard still shows its own top-5
      // GMV; the profile is the deeper view, and the deeper view is the upsell.
      ...(gmv && tier === 'paid' ? { gmv } : {}),
      products: productRows.map((p) => ({
        product_id: p.product_id,
        title: p.title,
        niche_slug: p.niche_slug,
        image_url: p.image_url,
        videos: p.videos,
        views: Number(p.views) || 0,
      })),
      productsTotal: totalProducts,
      productsPage: tier === 'free' ? 1 : page,
      productsLimit: limit,
      topVideos: profile.topVideos || [],
      tier,
    });
  } catch (err: any) {
    console.error('creator-profile error:', err?.message);
    return res.status(500).json({ error: 'Failed to load creator' });
  }
}
