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
  { slug: 'beauty-skincare', label: 'Beauty & Skincare' },
  { slug: 'gym-fitness', label: 'Gym & Fitness' },
  { slug: 'health-wellness', label: 'Health & Wellness' },
  { slug: 'mens-wear', label: "Men's Wear" },
  { slug: 'womens-wear', label: "Women's Wear" },
  { slug: 'tech-gadgets', label: 'Tech Gadgets' },
  { slug: 'pet-products', label: 'Pet Products' },
];

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

// Fetch top videos for a niche with timeframe filter
export async function fetchTopVideos(
  nicheSlug: string,
  days: number,
  page: number = 1,
  limit: number = 50
): Promise<{ videos: VideoWithProduct[]; total: number }> {
  const cutoff = getCutoffDate(days);
  const offset = (page - 1) * limit;

  // Step 1: Get product_ids for the niche
  const { data: products } = await query('products', {
    select: 'product_id',
    niche_slug: `eq.${nicheSlug}`,
  });

  if (!products || products.length === 0) return { videos: [], total: 0 };

  const productIds = products.map((p: any) => p.product_id);

  // Step 2: Get videos for those product IDs, sorted by view_count desc
  // Supabase REST API supports `in` filter
  // We need to batch if there are too many IDs (URL length limit)
  const batchSize = 150;
  let allVideos: any[] = [];

  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const inList = `(${batch.map((id: string) => `"${id}"`).join(',')})`;
    
    const { data: videos } = await query('product_videos', {
      select: '*',
      product_id: `in.${inList}`,
      created_at: `gte.${cutoff}`,
      order: 'view_count.desc',
      limit: '1000',
      offset: '0',
    });

    if (videos) allVideos = allVideos.concat(videos);
  }

  // Sort all videos by view_count desc and paginate
  allVideos.sort((a: any, b: any) => (b.view_count || 0) - (a.view_count || 0));
  const total = allVideos.length;
  const pageVideos = allVideos.slice(offset, offset + limit);

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

  const videosWithProducts: VideoWithProduct[] = pageVideos.map((v: any) => ({
    ...v,
    product: productsMap[v.product_id],
  }));

  return { videos: videosWithProducts, total };
}

// Fetch products for a niche with timeframe filter
export async function fetchProducts(
  nicheSlug: string,
  days: number,
  page: number = 1,
  limit: number = 50
): Promise<{ products: Product[]; total: number }> {
  const cutoff = getCutoffDate(days);
  const offset = (page - 1) * limit;

  const { data, count } = await query('products', {
    select: '*',
    niche_slug: `eq.${nicheSlug}`,
    updated_at: `gte.${cutoff}`,
    order: 'sold_count.desc',
    limit: limit.toString(),
    offset: offset.toString(),
  });

  return { products: (data || []) as Product[], total: count || 0 };
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
