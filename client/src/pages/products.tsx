import { useState, useEffect, type ReactNode } from 'react';
import {
  NICHES,
  TIMEFRAMES,
  formatViews,
  type Product,
  type ProductVideo,
} from '@/lib/supabase';
import { formatCompactNumber, type ProductEstimates } from '@/lib/estimates';
import { InfoTip } from '@/components/InfoTip';
import { useBookmarks } from '@/lib/bookmarks';
import { useSubscription } from '@/hooks/use-subscription';
import { Bookmark, ChevronLeft, ChevronRight, ExternalLink, ChevronUp, ChevronDown, TrendingUp, Lock, Package } from 'lucide-react';
import { LoadingBar } from '@/components/LoadingBar';

interface EnrichedProduct extends Product {
  metrics: ProductEstimates;
  topVideos: { video_url: string; view_count: number; cover_image_url: string }[];
}

type SortKey = 'periodViews' | 'sold_count' | 'estRevenue' | 'stock_quantity' | 'sale_price';
type SortDir = 'asc' | 'desc';

// Client-side cache for product API responses
const productCache = new Map<string, { data: any; timestamp: number }>();
const PRODUCT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchProducts(
  niche: string, days: number, page: number, limit: number, sort: string, dir: string
): Promise<{ products: EnrichedProduct[]; total: number }> {
  const cacheKey = `${niche}:${days}:${page}:${limit}:${sort}:${dir}`;
  const cached = productCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PRODUCT_CACHE_TTL) return cached.data;

  const params = new URLSearchParams({ niche, days: String(days), page: String(page), limit: String(limit), sort, dir });
  const res = await fetch(`/api/top-products?${params}`);
  if (!res.ok) throw new Error('Failed to fetch products');
  const data = await res.json();
  const result = { products: data.products || [], total: data.total || 0 };
  productCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
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
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[1]); // "2 Weeks"
  const [pageProducts, setPageProducts] = useState<EnrichedProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('estRevenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [mode, setMode] = useState<'bestsellers' | 'trending'>('bestsellers');
  const [page, setPage] = useState(1);

  // Ranking presets. Best Sellers = actual performance (revenue from real/
  // estimated units sold in the window). Trending = fastest-rising video
  // attention. Both are just a default sort over the same data; users can
  // still click any column to re-sort.
  function applyMode(next: 'bestsellers' | 'trending') {
    setMode(next);
    setSortKey(next === 'bestsellers' ? 'estRevenue' : 'periodViews');
    setSortDir('desc');
  }
  const { isProductBookmarked, toggleProductBookmark } = useBookmarks();

  const limit = 50;
  const totalPages = Math.ceil(total / limit);

  // Free users default to "1 Year" tab and page 3
  useEffect(() => {
    if (!isPaid) {
      const oneYear = TIMEFRAMES.find(t => t.label === '1 Year');
      if (oneYear) setTimeframe(oneYear);
      setPage(3);
    }
  }, [isPaid]);

  useEffect(() => { setPage(!isPaid ? 3 : 1); }, [timeframe, sortKey, sortDir, isPaid]);

  // Fetch products from server-side endpoint
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProducts(niche, timeframe.days, page, limit, sortKey, sortDir)
      .then(res => {
        if (!cancelled) {
          setPageProducts(res.products);
          setTotal(res.total);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [niche, timeframe, page, sortKey, sortDir]);

  // Pre-fetch the OTHER timeframes for snappier tab switching — but only after
  // the current view has loaded, and sequentially, so we don't fire several
  // heavy uncached computations at once and starve the foreground request.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const others = TIMEFRAMES.filter(t => t.days !== timeframe.days);
    (async () => {
      for (const t of others) {
        if (cancelled) return;
        await fetchProducts(niche, t.days, 1, limit, sortKey, sortDir).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [niche, loading]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function SortHeader({ label, sortKeyVal, tip, className = '' }: { label: string; sortKeyVal: SortKey; tip?: ReactNode; className?: string }) {
    const active = sortKey === sortKeyVal;
    return (
      <th
        className={`py-3 px-3 font-medium text-[11px] cursor-pointer select-none hover:text-foreground transition-colors ${active ? 'text-[#a3ff00]' : 'text-muted-foreground'} ${className}`}
        onClick={() => toggleSort(sortKeyVal)}
      >
        <div className={`flex items-center gap-1 ${className.includes('text-left') ? '' : 'justify-end'}`}>
          {label}
          {tip && <InfoTip size={11}>{tip}</InfoTip>}
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
          {mode === 'bestsellers'
            ? 'The best-performing products in your selected timeframe, ranked by revenue from units sold.'
            : 'Products with the fastest-rising TikTok video attention in your selected timeframe.'}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {/* Ranking-mode toggle */}
        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border">
          {([['bestsellers', 'Best Sellers'], ['trending', 'Trending']] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => applyMode(val)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${mode === val ? 'text-[#0a0a0c]' : 'text-muted-foreground hover:text-foreground'}`}
              style={mode === val ? { backgroundColor: '#a3ff00' } : undefined}
              data-testid={`mode-${val}`}
            >
              {label}
            </button>
          ))}
          <InfoTip size={12} className="mx-1">
            <span className="font-semibold text-foreground">Best Sellers</span> ranks by
            actual revenue from units sold in the window (real sales when available,
            otherwise estimated). <span className="font-semibold text-foreground">Trending</span> ranks
            by fastest-rising video views. Click any column to re-sort.
          </InfoTip>
        </div>

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
            const isLocked = !isPaid && tf.label !== '1 Year';
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
          {loading ? '...' : `${total.toLocaleString()} products`}
        </span>
      </div>

      {/* Info banner */}
      <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-md bg-zinc-900/60 border border-zinc-800 text-[11px] text-zinc-400">
        <TrendingUp size={13} className="text-zinc-500 flex-shrink-0" />
        <span>
          {mode === 'bestsellers'
            ? 'Ranked by revenue from units sold in the selected timeframe. Rows marked “in period” use real day-over-day sales; “estimated” rows are modeled from views until more sales history accrues.'
            : 'Ranked by views from TikTok videos posted within the selected timeframe. Products with no recent video activity rank lower.'}
        </span>
      </div>

      {loading && <LoadingBar loading={loading} />}

      {!loading && total === 0 && (
        <div className="flex flex-col items-center text-center py-20 px-6">
          <div className="w-11 h-11 rounded-full bg-secondary/60 flex items-center justify-center mb-3">
            <Package size={20} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">No products in this view yet</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            No products have recent video activity for this niche and timeframe. Try a
            broader timeframe (like 1 Year) or switch niche to <span className="text-foreground">All</span>.
          </p>
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
                  <SortHeader
                    label="Period Views"
                    sortKeyVal="periodViews"
                    tip="Total TikTok views from videos about this product posted within your selected timeframe. This is the main ranking signal — products with fresh viral videos rank highest."
                  />
                  <SortHeader
                    label="Revenue"
                    sortKeyVal="estRevenue"
                    tip="Estimated revenue for the period = estimated units sold × price. A ≈ means the price was estimated from the category median. Directional, not exact sales."
                  />
                  <SortHeader
                    label="Units Sold"
                    sortKeyVal="sold_count"
                    tip="Estimated units sold during the selected period. “in period” = measured from real day-over-day sales snapshots; “estimated” = modeled from views when snapshot data isn’t available yet."
                  />
                  <SortHeader
                    label="Price"
                    sortKeyVal="sale_price"
                    tip="Current listed sale price on TikTok Shop (US region)."
                  />
                  <th className="text-left py-3 px-3 font-medium text-[11px] text-muted-foreground min-w-[160px]">
                    <div className="flex items-center gap-1">
                      Top Videos
                      <InfoTip size={11}>
                        The highest-viewed TikTok videos driving this product. Hover a thumbnail for its view count; click to open on TikTok.
                      </InfoTip>
                    </div>
                  </th>
                  <th className="py-3 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(() => {
                  return pageProducts.map((product, idx) => {
                  const rank = (page - 1) * limit + idx + 1;
                  const isRowLocked = !isPaid && (rank < 101 || rank > 150);
                  const m = product.metrics;
                  const price = product.sale_price || 0;
                  const bookmarked = isProductBookmarked(product.product_id);

                  // Top 5 videos pre-sorted by server
                  const displayVideos = product.topVideos || [];

                  if (isRowLocked) {
                    return (
                      <tr key={product.product_id} className="relative cursor-pointer" onClick={() => showPaywall('top_products')}>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono font-bold"
                            style={rank <= 3 ? { backgroundColor: '#a3ff00', color: '#0a0a0c' } : { backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}>
                            {rank}
                          </span>
                        </td>
                        <td colSpan={10} className="py-3 px-3">
                          <div className="relative overflow-hidden rounded h-10 flex items-center">
                            <div className="absolute inset-0 bg-muted/40 backdrop-blur-sm" />
                            <div className="relative z-10 flex items-center gap-2 w-full justify-center">
                              <Lock size={14} className="text-[#a3ff00]" />
                              <span className="text-[11px] font-medium text-white">Upgrade to unlock</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  }

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
                        <div title={m.periodViews.toLocaleString() + ' views from ' + m.periodVideoCount + ' videos posted in this period\n' + m.totalViews.toLocaleString() + ' total views from ' + (product.topVideos || []).length + ' videos all-time'}>
                          <span className="font-mono text-xs font-semibold text-foreground">
                            {m.periodViews > 0 ? formatCompactNumber(m.periodViews) : (
                              m.totalViews > 0 ? <span className="text-zinc-500">{formatCompactNumber(m.totalViews)}</span> : <span className="text-zinc-500 font-normal">--</span>
                            )}
                          </span>
                          <div className="text-[9px] font-mono mt-0.5">
                            {m.periodVideoCount > 0 
                              ? <span className="text-zinc-500">{m.periodVideoCount} recent / {(product.topVideos || []).length} total</span>
                              : <span className="text-zinc-500">{(product.topVideos || []).length} video{(product.topVideos || []).length !== 1 ? 's' : ''}</span>
                            }
                            {(product.topVideos || []).length < 5 && (product.topVideos || []).length > 0 && (
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
                            <a key={vid.video_url} href={vid.video_url} target="_blank" rel="noopener noreferrer" className="block flex-shrink-0 relative group">
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
                          {(product.topVideos || []).length === 0 && <span className="text-[10px] text-muted-foreground">--</span>}
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <button onClick={() => toggleProductBookmark(product)} className="w-7 h-7 rounded flex items-center justify-center hover:bg-secondary transition-colors">
                          <Bookmark size={14} className={bookmarked ? 'text-[#a3ff00] fill-[#a3ff00]' : 'text-muted-foreground'} />
                        </button>
                      </td>
                    </tr>
                  );
                });
                })()}
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
