// Direct Supabase REST API client without the SDK
// (SDK uses localStorage/sessionStorage which are blocked in sandboxed iframes)

const SUPABASE_URL = 'https://ntapskfgodvynlfyulnv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50YXBza2Znb2R2eW5sZnl1bG52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzEyNzUsImV4cCI6MjA4OTIwNzI3NX0.jOA-9kwBrOsfc8uqFFcyp0PajoKl9HQcRmaliYELBQo';

const REST_URL = `${SUPABASE_URL}/rest/v1`;

const headers = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'count=exact',
};

async function query(table: string, params: Record<string, string> = {}): Promise<{ data: any[]; count: number | null }> {
  const url = new URL(`${REST_URL}/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error: ${res.status} ${text}`);
  }
  
  const data = await res.json();
  const contentRange = res.headers.get('content-range');
  let count: number | null = null;
  if (contentRange) {
    const match = contentRange.match(/\/(\d+|\*)/);
    if (match && match[1] !== '*') count = parseInt(match[1], 10);
  }
  
  return { data, count };
}

export interface Product {
  id: number;
  product_id: string;
  title: string;
  niche_slug: string;
  niche_label: string;
  image_url: string;
  sale_price: number;
  original_price: number;
  discount_percent: number;
  currency: string;
  sold_count: number;
  stock_quantity: number;
  rating: number;
  review_count: number;
  commission_rate: number;
  seller_name: string;
  seller_id: string;
  seller_product_count: number;
  seller_location: string;
  seller_tiktok_url: string;
  region: string;
  product_url: string;
  created_at: string;
  updated_at: string;
}

export interface ProductVideo {
  id: number;
  product_id: string;
  video_url: string;
  view_count: number;
  author_name: string;
  author_avatar_url: string;
  created_at: string;
  cover_image_url: string;
}

export interface VideoWithProduct extends ProductVideo {
  product?: Product;
}

export const NICHES = [
  { slug: 'all', label: 'All Categories' },
  { slug: 'beauty-skincare', label: 'Beauty & Skincare' },
  { slug: 'gym-fitness', label: 'Gym & Fitness' },
  { slug: 'health-wellness', label: 'Health & Wellness' },
  { slug: 'mens-wear', label: "Men's Wear" },
  { slug: 'womens-wear', label: "Women's Wear" },
  { slug: 'tech-gadgets', label: 'Tech Gadgets' },
  { slug: 'pet-products', label: 'Pet Products' },
];

// Niches without the 'all' option (for Videos page which doesn't support all)
export const NICHES_NO_ALL = NICHES.filter(n => n.slug !== 'all');

export const TIMEFRAMES = [
  { label: '1 Week', days: 7 },
  { label: '2 Weeks', days: 14 },
  { label: '1 Month', days: 30 },
  { label: '3 Months', days: 90 },
  { label: '6 Months', days: 180 },
  { label: '1 Year', days: 365 },
];

export function getCutoffDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// Extract actual TikTok post date from video URL using snowflake ID
export function extractPostDate(videoUrl: string): Date | null {
  if (!videoUrl) return null;
  const match = videoUrl.match(/video\/(\d+)/);
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

export function formatViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

export function formatRevenue(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + n.toFixed(2);
}

export function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  return `${diffMonths}mo ago`;
}

// Fetch top videos for a niche, filtered by ACTUAL TikTok post date.
// The post date is extracted from the video URL's snowflake ID.
export async function fetchTopVideos(
  nicheSlug: string,
  days: number,
  page: number = 1,
  limit: number = 50
): Promise<{ videos: VideoWithProduct[]; total: number }> {
  const offset = (page - 1) * limit;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  // Step 1: Get ALL product_ids for the niche
  const productParams: Record<string, string> = {
    select: 'product_id',
    limit: '2000',
  };
  if (nicheSlug !== 'all') {
    productParams.niche_slug = `eq.${nicheSlug}`;
  }
  const { data: products } = await query('products', productParams);

  if (!products || products.length === 0) return { videos: [], total: 0 };

  const productIds = products.map((p: any) => p.product_id);

  // Step 2: Get ALL videos for those products
  const batchSize = 150;
  let allVideos: any[] = [];

  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const inList = `(${batch.map((id: string) => `"${id}"`).join(',')})`;
    
    const { data: videos } = await query('product_videos', {
      select: '*',
      product_id: `in.${inList}`,
      order: 'view_count.desc',
      limit: '5000',
      offset: '0',
    });

    if (videos) allVideos = allVideos.concat(videos);
  }

  // Step 3: Deduplicate by video ID (same video can appear under different products or URL formats)
  const seenVideoIds = new Set<string>();
  const deduped = allVideos.filter((v: any) => {
    const vidId = v.video_url?.match(/video\/(\d+)/)?.[1];
    if (!vidId || seenVideoIds.has(vidId)) return false;
    seenVideoIds.add(vidId);
    return true;
  });

  // Step 4: Annotate each video with its actual TikTok post date
  const annotated = deduped.map((v: any) => ({
    ...v,
    _postDate: extractPostDate(v.video_url),
  })).filter((v: any) => v._postDate !== null);

  // Step 5: Filter by actual TikTok post date — strict, no fallback
  // If "2 Weeks" is selected, only show videos posted in the last 14 days. Period.
  const filteredVideos = annotated
    .filter((v: any) => v._postDate >= cutoffDate)
    .sort((a: any, b: any) => (b.view_count || 0) - (a.view_count || 0));
  const total = filteredVideos.length;
  const pageVideos = filteredVideos.slice(offset, offset + limit);

  // Step 3: Get product details for the videos on this page
  const videoProductIds = [...new Set(pageVideos.map((v: any) => v.product_id))];

  let productsMap: Record<string, Product> = {};
  if (videoProductIds.length > 0) {
    for (let i = 0; i < videoProductIds.length; i += batchSize) {
      const batch = videoProductIds.slice(i, i + batchSize);
      const inList = `(${batch.map((id: string) => `"${id}"`).join(',')})`;
      const { data: prods } = await query('products', {
        select: '*',
        product_id: `in.${inList}`,
      });
      if (prods) {
        prods.forEach((p: any) => { productsMap[p.product_id] = p as Product; });
      }
    }
  }

  const videosWithProducts: VideoWithProduct[] = pageVideos.map((v: any) => {
    const product = productsMap[v.product_id];
    // Filter out placeholder/category-level products that aren't real
    const isPlaceholder = product && (
      (product.title && product.title.includes('Discovered Videos')) ||
      (product.sold_count === 0 && product.review_count === 0 && product.rating === 0)
    );
    return {
      ...v,
      product: isPlaceholder ? undefined : product,
    };
  });

  return { videos: videosWithProducts, total };
}

// Fetch products for a niche with time-scoped data.
// Uses snapshot deltas when available, falls back to cumulative data.
export async function fetchProducts(
  nicheSlug: string,
  days: number,
  page: number = 1,
  limit: number = 50
): Promise<{ products: (Product & { period_sold?: number; period_revenue?: number })[]; total: number }> {
  const offset = (page - 1) * limit;

  // Get all products for this niche
  const { data: allProducts } = await query('products', {
    select: '*',
    niche_slug: `eq.${nicheSlug}`,
    limit: '2000',
  });

  if (!allProducts || allProducts.length === 0) return { products: [], total: 0 };

  // Try to get snapshot data for delta calculations
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  // Get snapshots for all products in this niche
  const productIds = allProducts.map((p: any) => p.product_id);
  const batchSize = 150;
  let allSnapshots: any[] = [];

  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const inList = `(${batch.map((id: string) => `"${id}"`).join(',')})`;
    const { data: snaps } = await query('product_snapshots', {
      select: '*',
      product_id: `in.${inList}`,
      order: 'snapshot_date.asc',
      limit: '5000',
    });
    if (snaps) allSnapshots = allSnapshots.concat(snaps);
  }

  // Build snapshot map: product_id -> sorted snapshots
  const snapMap: Record<string, any[]> = {};
  for (const s of allSnapshots) {
    if (!snapMap[s.product_id]) snapMap[s.product_id] = [];
    snapMap[s.product_id].push(s);
  }

  // Calculate period-specific metrics for each product
  const enrichedProducts = allProducts.map((p: any) => {
    const snaps = snapMap[p.product_id] || [];
    const price = p.sale_price || 0;

    if (snaps.length >= 2) {
      // Find the closest snapshot to the cutoff date and the most recent one
      const sortedSnaps = snaps.sort((a: any, b: any) => a.snapshot_date.localeCompare(b.snapshot_date));
      const latestSnap = sortedSnaps[sortedSnaps.length - 1];
      
      // Find snapshot closest to cutoff
      let earliestSnap = sortedSnaps[0];
      for (const s of sortedSnaps) {
        if (s.snapshot_date <= cutoffStr) earliestSnap = s;
        else break;
      }

      const deltaSold = Math.max(0, (latestSnap.sold_count || 0) - (earliestSnap.sold_count || 0));
      const snapPrice = latestSnap.sale_price || earliestSnap.sale_price || price;
      
      return {
        ...p,
        period_sold: deltaSold,
        period_revenue: deltaSold * snapPrice,
        _sortValue: deltaSold,
      };
    }

    // No delta data — use cumulative values
    return {
      ...p,
      period_sold: p.sold_count || 0,
      period_revenue: (p.sold_count || 0) * price,
      _sortValue: p.sold_count || 0,
    };
  });

  // Sort by period sold (descending) and paginate
  enrichedProducts.sort((a: any, b: any) => (b._sortValue || 0) - (a._sortValue || 0));
  const total = enrichedProducts.length;
  const pageProducts = enrichedProducts.slice(offset, offset + limit);

  return { products: pageProducts, total };
}

// Fetch top videos for a product (for product table thumbnails)
export async function fetchProductVideos(
  productIds: string[]
): Promise<Record<string, ProductVideo[]>> {
  if (productIds.length === 0) return {};

  const result: Record<string, ProductVideo[]> = {};
  const batchSize = 150;

  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const inList = `(${batch.map((id: string) => `"${id}"`).join(',')})`;
    const { data } = await query('product_videos', {
      select: '*',
      product_id: `in.${inList}`,
      order: 'view_count.desc',
    });

    if (data) {
      data.forEach((v: any) => {
        if (!result[v.product_id]) result[v.product_id] = [];
        if (result[v.product_id].length < 5) {
          result[v.product_id].push(v as ProductVideo);
        }
      });
    }
  }

  return result;
}
