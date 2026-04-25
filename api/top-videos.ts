// Server-side video ranking endpoint. Pre-computes the heavy
// video-fetching + snowflake-filtering + product-joining that was
// previously done in the browser (42K rows per page load).
//
// Caches results for 1 hour since data only changes daily.
// Returns paginated results for a given niche + timeframe.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

interface CachedResult {
  videos: any[];
  timestamp: number;
}

// In-memory cache: key = "niche:days", value = enriched video list
const cache = new Map<string, CachedResult>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function extractPostDate(videoUrl: string): Date | null {
  const match = videoUrl?.match(/video\/(\d+)/);
  if (!match) return null;
  try {
    const videoId = BigInt(match[1]);
    const timestamp = Number(videoId >> 32n);
    const date = new Date(timestamp * 1000);
    if (date.getFullYear() < 2020 || date.getFullYear() > 2027) return null;
    return date;
  } catch {
    return null;
  }
}

async function computeTopVideos(nicheSlug: string, days: number): Promise<any[]> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase env vars');

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cutoffDate = new Date(Date.now() - days * 86400000);

  // Step 1: Get product_ids with sold_count > 0 for the niche
  let productIds: string[] = [];
  if (nicheSlug !== 'all') {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('product_id')
        .eq('niche_slug', nicheSlug)
        .gt('sold_count', 0)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      productIds = productIds.concat(data.map((p: any) => p.product_id));
      if (data.length < 1000) break;
      offset += 1000;
    }
  }

  // Step 2: Fetch all videos (for "all") or niche videos
  let allVideos: any[] = [];
  if (nicheSlug === 'all') {
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('product_videos')
        .select('*')
        .order('view_count', { ascending: false })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      allVideos = allVideos.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  } else {
    // Batch by product_ids
    for (let i = 0; i < productIds.length; i += 150) {
      const batch = productIds.slice(i, i + 150);
      const { data } = await supabase
        .from('product_videos')
        .select('*')
        .in('product_id', batch)
        .order('view_count', { ascending: false })
        .limit(5000);
      if (data) allVideos = allVideos.concat(data);
    }
  }

  // Step 3: Dedup by video ID
  const seen = new Set<string>();
  const deduped = allVideos.filter((v: any) => {
    const vidId = v.video_url?.match(/video\/(\d+)/)?.[1];
    if (!vidId || seen.has(vidId)) return false;
    seen.add(vidId);
    return true;
  });

  // Step 4: Filter by snowflake post date
  const filtered = deduped
    .filter((v: any) => {
      const postDate = extractPostDate(v.video_url);
      if (!postDate) return false;
      return postDate >= cutoffDate;
    })
    .sort((a: any, b: any) => (b.view_count || 0) - (a.view_count || 0));

  // Step 5: Fetch product details for filtered videos
  const videoProductIds = [...new Set(filtered.map((v: any) => v.product_id))] as string[];
  const productsMap: Record<string, any> = {};

  for (let i = 0; i < videoProductIds.length; i += 200) {
    const batch = videoProductIds.slice(i, i + 200);
    const { data } = await supabase
      .from('products')
      .select('product_id, title, niche_slug, niche_label, image_url, sale_price, sold_count, product_url')
      .in('product_id', batch);
    if (data) data.forEach((p: any) => { productsMap[p.product_id] = p; });
  }

  // Step 6: Build final list — only videos with real products that have sales
  const enriched = filtered
    .map((v: any) => {
      const product = productsMap[v.product_id];
      if (!product) return null;
      if (product.title?.includes('Discovered Videos')) return null;
      if ((product.sold_count ?? 0) <= 0) return null;
      return {
        product_id: v.product_id,
        video_url: v.video_url,
        view_count: v.view_count,
        author_name: v.author_name,
        author_avatar_url: v.author_avatar_url,
        cover_image_url: v.cover_image_url,
        created_at: v.created_at,
        product,
      };
    })
    .filter(Boolean);

  return enriched;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const nicheSlug = (req.query.niche as string) || 'all';
    const days = parseInt((req.query.days as string) || '7', 10);
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '50', 10);

    // Validate
    if (![7, 14, 30, 90, 180, 365].includes(days)) {
      return res.status(400).json({ error: 'Invalid days parameter' });
    }

    const cacheKey = `${nicheSlug}:${days}`;
    const cached = cache.get(cacheKey);

    let videos: any[];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      videos = cached.videos;
    } else {
      videos = await computeTopVideos(nicheSlug, days);
      cache.set(cacheKey, { videos, timestamp: Date.now() });
    }

    const offset = (page - 1) * limit;
    const paginated = videos.slice(offset, offset + limit);

    // Set cache headers — browser can cache for 5 min, CDN for 1 hour
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400, max-age=300');

    return res.json({
      videos: paginated,
      total: videos.length,
      page,
      limit,
    });
  } catch (err: any) {
    console.error('top-videos error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch videos' });
  }
}
