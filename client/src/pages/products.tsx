import { useState, useEffect, useMemo } from 'react';
import {
  NICHES,
  TIMEFRAMES,
  formatViews,
  type Product,
  type ProductVideo,
} from '@/lib/supabase';
import { calculateProductMetrics, calculateMedianPrice, formatCompactNumber, getVideoPostDate, type ProductEstimates, type VideoForEstimate, type SnapshotData } from '@/lib/estimates';
import { useBookmarks } from '@/lib/bookmarks';
import { useSubscription } from '@/hooks/use-subscription';
import { Bookmark, ChevronLeft, ChevronRight, Star, ExternalLink, ChevronUp, ChevronDown, TrendingUp, Lock } from 'lucide-react';

const SUPABASE_URL = 'https://ntapskfgodvynlfyulnv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50YXBza2Znb2R2eW5sZnl1bG52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzEyNzUsImV4cCI6MjA4OTIwNzI3NX0.jOA-9kwBrOsfc8uqFFcyp0PajoKl9HQcRmaliYELBQo';
const headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` };

interface EnrichedProduct extends Product {
  metrics: ProductEstimates;
  videos: ProductVideo[];
}

type SortKey = 'periodViews' | 'sold_count' | 'estRevenue' | 'stock_quantity' | 'rating' | 'review_count' | 'sale_price';
type SortDir = 'asc' | 'desc';

async function fetchAll(table: string, params: string): Promise<any[]> {
  let all: any[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}&limit=1000&offset=${offset}`, { headers });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return all;
}

function formatRevenue(n: number): string {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n > 0) return '$' + n.toFixed(2);
  return '--';
}



export default function ProductsPage() {
  const [niche, setNiche] = useState(NICHES[0].slug);
  const { isPaid, showPaywall } = useSubscription();
  // Default to 2 Weeks always, upgrade to 1 Month once we confirm paid status
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[1]); // "2 Weeks"
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [allVideos, setAllVideos] = useState<Record<string, ProductVideo[]>>({});
  const [snapshotMap, setSnapshotMap] = useState<Record<string, SnapshotData[]>>({});
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('estRevenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const { isProductBookmarked, toggleProductBookmark } = useBookmarks();

  const limit = 50;

  // Fetch products + ALL their videos when niche changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(1);

    (async () => {
      // Get all products for niche
      // Handle 'all' category — fetch top 500 across all niches
      const products = niche === 'all'
        ? await fetchAll('products', `select=*&order=sold_count.desc.nullslast&limit=500`)
        : await fetchAll('products', `select=*&niche_slug=eq.${niche}`);
      if (cancelled) return;
      setAllProducts(products);

      // Get ALL videos + snapshots for these products
      const pids = products.map((p: any) => p.product_id);
      const videoMap: Record<string, ProductVideo[]> = {};
      const snapMap: Record<string, SnapshotData[]> = {};
      const batchSize = 150;

      for (let i = 0; i < pids.length; i += batchSize) {
        const batch = pids.slice(i, i + batchSize);
        const inList = `(${batch.map((id: string) => `"${id}"`).join(',')})`;;
        
        // Fetch videos
        const vids = await fetchAll('product_videos', `select=*&product_id=in.${inList}&order=view_count.desc`);
        for (const v of vids) {
          if (!videoMap[v.product_id]) videoMap[v.product_id] = [];
          videoMap[v.product_id].push(v);
        }
        
        // Fetch snapshots
        const snaps = await fetchAll('product_snapshots', `select=product_id,sold_count,sale_price,snapshot_date&product_id=in.${inList}&order=snapshot_date.asc`);
        for (const s of snaps) {
          if (!snapMap[s.product_id]) snapMap[s.product_id] = [];
          snapMap[s.product_id].push(s);
        }
      }

      if (cancelled) return;
      setAllVideos(videoMap);
      setSnapshotMap(snapMap);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [niche]);

  useEffect(() => { setPage(1); }, [timeframe, sortKey, sortDir]);

  // Compute metrics for all products based on current timeframe
  const enrichedProducts = useMemo(() => {
    // Calculate median price for this niche (used as fallback for products without price)
    const medianPrice = calculateMedianPrice(allProducts as any, niche);

    return allProducts
      .filter(p => (p.sold_count || 0) > 0)
      .map(p => {
        const videos = allVideos[p.product_id] || [];
        const videoData: VideoForEstimate[] = videos.map(v => ({
          video_url: v.video_url,
          view_count: v.view_count,
        }));
        const productSnapshots = snapshotMap[p.product_id] || [];
        const metrics = calculateProductMetrics(
          { product_id: p.product_id, sold_count: p.sold_count, review_count: p.review_count, sale_price: p.sale_price, niche_slug: (p as any).niche_slug },
          videoData,
          timeframe.days,
          medianPrice,
          productSnapshots
        );
        return { ...p, metrics, videos } as EnrichedProduct;
      });
  }, [allProducts, allVideos, snapshotMap, timeframe, niche]);

  // Sort
  const sortedProducts = useMemo(() => {
    return [...enrichedProducts].sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortKey) {
        case 'periodViews': aVal = a.metrics.periodViews; bVal = b.metrics.periodViews; break;
        case 'sold_count': aVal = a.metrics.estPeriodUnitsSold; bVal = b.metrics.estPeriodUnitsSold; break;
        case 'estRevenue': aVal = a.metrics.estRevenue; bVal = b.metrics.estRevenue; break;

        case 'stock_quantity': aVal = a.stock_quantity || 0; bVal = b.stock_quantity || 0; break;
        case 'rating': aVal = a.rating || 0; bVal = b.rating || 0; break;
        case 'review_count': aVal = a.review_count || 0; bVal = b.review_count || 0; break;
        case 'sale_price': aVal = a.sale_price || 0; bVal = b.sale_price || 0; break;
        default: aVal = 0; bVal = 0;
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });
  }, [enrichedProducts, sortKey, sortDir]);

  const totalPages = Math.ceil(sortedProducts.length / limit);
  const pageProducts = sortedProducts.slice((page - 1) * limit, page * limit);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function SortHeader({ label, sortKeyVal, className = '' }: { label: string; sortKeyVal: SortKey; className?: string }) {
    const active = sortKey === sortKeyVal;
    return (
      <th
        className={`py-3 px-3 font-medium text-[11px] cursor-pointer select-none hover:text-foreground transition-colors ${active ? 'text-[#a3ff00]' : 'text-muted-foreground'} ${className}`}
        onClick={() => toggleSort(sortKeyVal)}
      >
        <div className={`flex items-center gap-1 ${className.includes('text-left') ? '' : 'justify-end'}`}>
          {label}
          {active && (sortDir === 'desc' ? <ChevronDown size={12} className="text-[#a3ff00]" /> : <ChevronUp size={12} className="text-[#a3ff00]" />)}
        </div>
      </th>
    );
  }

  return (
    <div className="p-6" data-testid="products-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Top Products</h1>
        <p className="text-sm text-muted-foreground">
          Ranked by video views within the selected timeframe — products with recent viral content rank highest
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <select value={niche} onChange={e => {
            if (!isPaid && e.target.value !== 'all') {
              e.target.value = 'all';
              showPaywall('category_filter');
              return;
            }
            setNiche(e.target.value);
          }}
          className="h-9 px-3 rounded-md text-sm font-medium border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer">
          {NICHES.map(n => (
            <option key={n.slug} value={n.slug} disabled={!isPaid && n.slug !== 'all'}>
              {n.label}{!isPaid && n.slug !== 'all' ? ' 🔒' : ''}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border">
          {TIMEFRAMES.map(tf => {
            const isLocked = !isPaid && tf.label !== '2 Weeks';
            return (
              <button key={tf.label}
                onClick={() => {
                  if (isLocked) { showPaywall('timeframe'); return; }
                  setTimeframe(tf);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${timeframe.label === tf.label ? 'text-[#0a0a0c]' : isLocked ? 'text-zinc-600' : 'text-muted-foreground hover:text-foreground'}`}
                style={timeframe.label === tf.label ? { backgroundColor: '#a3ff00' } : undefined}>
                {tf.label}
                {isLocked && <Lock size={8} className="inline ml-1 opacity-50" />}
              </button>
            );
          })}
        </div>

        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {loading ? '...' : `${sortedProducts.length.toLocaleString()} products`}
        </span>
      </div>

      {/* Info banner */}
      <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md bg-zinc-900/60 border border-zinc-800 text-[11px] text-zinc-400">
        <TrendingUp size={13} className="text-zinc-500 flex-shrink-0" />
        <span>
          Products ranked by views from TikTok videos posted within the selected timeframe.
          Products with no recent video activity will rank lower.
        </span>
      </div>

      {/* Loading */}
      {loading && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="divide-y divide-border">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-16 px-4 flex items-center gap-4 animate-pulse">
                <div className="w-6 h-4 bg-muted rounded" />
                <div className="w-10 h-10 bg-muted rounded" />
                <div className="flex-1"><div className="h-3 bg-muted rounded w-48" /></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && sortedProducts.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-sm">No products found for this niche/timeframe.</p>
        </div>
      )}

      {!loading && pageProducts.length > 0 && (
        <>
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-3 font-medium text-[11px] text-muted-foreground w-12">#</th>
                  <th className="text-left py-3 px-3 font-medium text-[11px] text-muted-foreground min-w-[220px]">Product</th>
                  <SortHeader label="Period Views" sortKeyVal="periodViews" />
                  <SortHeader label="Revenue" sortKeyVal="estRevenue" />
                  <SortHeader label="Units Sold" sortKeyVal="sold_count" />

                  <SortHeader label="Stock" sortKeyVal="stock_quantity" />
                  <SortHeader label="Rating" sortKeyVal="rating" />
                  <SortHeader label="Reviews" sortKeyVal="review_count" />
                  <SortHeader label="Price" sortKeyVal="sale_price" />
                  <th className="text-left py-3 px-3 font-medium text-[11px] text-muted-foreground min-w-[160px]">Top Videos</th>
                  <th className="py-3 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageProducts.map((product, idx) => {
                  const rank = (page - 1) * limit + idx + 1;
                  const m = product.metrics;
                  const price = product.sale_price || 0;
                  const bookmarked = isProductBookmarked(product.product_id);

                  // Always show the top 5 videos by views (not filtered by timeframe)
                  const displayVideos = [...product.videos]
                    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
                    .slice(0, 5);

                  return (
                    <tr key={product.product_id} className="hover:bg-secondary/30 transition-colors">
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono font-bold"
                          style={rank <= 3 ? { backgroundColor: '#a3ff00', color: '#0a0a0c' } : { backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}>
                          {rank}
                        </span>
                      </td>

                      <td className="py-3 px-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded border border-border flex-shrink-0 overflow-hidden bg-zinc-800">
                            {product.image_url && <img src={product.image_url} alt="" className="w-full h-full object-cover" loading="lazy" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground line-clamp-2 leading-snug">{product.title}</p>
                            {product.product_url && (
                              <a
                                href={isPaid ? product.product_url : undefined}
                                onClick={e => { if (!isPaid) { e.preventDefault(); showPaywall('product_detail'); } }}
                                target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] text-[#a3ff00] hover:underline mt-0.5 cursor-pointer"
                              >
                                <ExternalLink size={9} /> View
                              </a>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Period Views — the ranking signal */}
                      <td className="py-3 px-3 text-right">
                        <div title={m.periodViews.toLocaleString() + ' views from ' + m.periodVideoCount + ' videos posted in this period\n' + m.totalViews.toLocaleString() + ' total views from ' + product.videos.length + ' videos all-time'}>
                          <span className="font-mono text-xs font-semibold text-foreground">
                            {m.periodViews > 0 ? formatCompactNumber(m.periodViews) : (
                              m.totalViews > 0 ? <span className="text-zinc-500">{formatCompactNumber(m.totalViews)}</span> : <span className="text-zinc-500 font-normal">--</span>
                            )}
                          </span>
                          <div className="text-[9px] font-mono mt-0.5">
                            {m.periodVideoCount > 0 
                              ? <span className="text-zinc-500">{m.periodVideoCount} recent / {product.videos.length} total</span>
                              : <span className="text-zinc-500">{product.videos.length} video{product.videos.length !== 1 ? 's' : ''}</span>
                            }
                            {product.videos.length < 5 && product.videos.length > 0 && (
                              <div className="text-[8px] text-amber-500/80 mt-0.5">limited data</div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Revenue */}
                      <td className="py-3 px-3 text-right">
                        {m.estRevenue > 0 ? (
                          <div>
                            <span className="font-mono text-xs font-semibold text-[#a3ff00]">
                              {!m.hasRealPrice ? '≈ ' : ''}{formatRevenue(m.estRevenue)}
                            </span>
                            {!m.hasRealPrice && (
                              <div className="text-[9px] text-zinc-500 font-mono mt-0.5">est. price</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-500 text-xs">--</span>
                        )}
                      </td>

                      {/* Units Sold */}
                      <td className="py-3 px-3 text-right">
                        <div>
                          <span className="font-mono text-xs text-foreground">
                            {m.hasRealDelta ? '' : '≈ '}{m.estPeriodUnitsSold.toLocaleString()}
                          </span>
                          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">
                            {m.hasRealDelta ? 'in period' : 'estimated'}
                          </div>
                        </div>
                      </td>



                      {/* Stock */}
                      <td className="py-3 px-3 text-right">
                        <span className="font-mono text-xs text-muted-foreground">
                          {(product.stock_quantity || 0).toLocaleString()}
                        </span>
                      </td>

                      {/* Rating */}
                      <td className="py-3 px-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          <Star size={10} className="text-yellow-500 fill-yellow-500" />
                          <span className="font-mono text-xs text-foreground">{(product.rating || 0).toFixed(1)}</span>
                        </div>
                      </td>

                      {/* Reviews */}
                      <td className="py-3 px-3 text-right">
                        <span className="font-mono text-xs text-muted-foreground">
                          {(product.review_count || 0).toLocaleString()}
                        </span>
                      </td>

                      {/* Price */}
                      <td className="py-3 px-3 text-right">
                        <span className="font-mono text-xs font-medium text-foreground">
                          {price > 0 ? `$${price.toFixed(2)}` : '--'}
                        </span>
                      </td>

                      {/* Top Videos */}
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-1">
                          {displayVideos.slice(0, 5).map(vid => (
                            <a key={vid.id} href={vid.video_url} target="_blank" rel="noopener noreferrer" className="block flex-shrink-0 relative group">
                              <div className="w-8 h-8 rounded border border-border overflow-hidden bg-zinc-800 hover:border-primary/50 transition-colors">
                                {vid.cover_image_url ? (
                                  <img src={vid.cover_image_url} alt="" className="w-full h-full object-cover" loading="lazy"
                                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center text-zinc-500 text-[10px]">▶</div>'; }} />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-500 text-[10px]">▶</div>
                                )}
                              </div>
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-black/90 text-[10px] font-mono text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                {formatViews(vid.view_count || 0)} views
                              </div>
                            </a>
                          ))}
                          {product.videos.length === 0 && <span className="text-[10px] text-muted-foreground">--</span>}
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <button onClick={() => toggleProductBookmark(product)} className="w-7 h-7 rounded flex items-center justify-center hover:bg-secondary transition-colors">
                          <Bookmark size={14} className={bookmarked ? 'text-[#a3ff00] fill-[#a3ff00]' : 'text-muted-foreground'} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6 mb-4">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors">
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-mono text-muted-foreground px-3">{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
