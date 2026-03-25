import { useState, useEffect } from 'react';
import {
  NICHES,
  TIMEFRAMES,
  fetchProducts,
  fetchProductVideos,
  formatRevenue,
  type Product,
  type ProductVideo,
} from '@/lib/supabase';
import { useBookmarks } from '@/lib/bookmarks';
import { Bookmark, ChevronLeft, ChevronRight, Star, ExternalLink } from 'lucide-react';

export default function ProductsPage() {
  const [niche, setNiche] = useState(NICHES[0].slug);
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[0]);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [videoMap, setVideoMap] = useState<Record<string, ProductVideo[]>>({});
  const { isProductBookmarked, toggleProductBookmark } = useBookmarks();

  const limit = 50;
  const totalPages = Math.ceil(total / limit);

  useEffect(() => {
    setPage(1);
  }, [niche, timeframe]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProducts(niche, timeframe.days, page, limit)
      .then(async res => {
        if (cancelled) return;
        setProducts(res.products);
        setTotal(res.total);
        // Fetch top videos for these products
        const productIds = res.products.map(p => p.product_id);
        const vids = await fetchProductVideos(productIds);
        if (!cancelled) {
          setVideoMap(vids);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [niche, timeframe, page]);

  return (
    <div className="p-6" data-testid="products-page">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Top Products</h1>
        <p className="text-sm text-muted-foreground">
          Best-selling TikTok Shop products ranked by units sold
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select
          value={niche}
          onChange={e => setNiche(e.target.value)}
          className="h-9 px-3 rounded-md text-sm font-medium border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          data-testid="niche-filter"
        >
          {NICHES.map(n => (
            <option key={n.slug} value={n.slug}>
              {n.label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-card rounded-lg p-1 border border-border">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf.label}
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                timeframe.label === tf.label
                  ? 'text-[#0a0a0c]'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              style={
                timeframe.label === tf.label
                  ? { backgroundColor: '#a3ff00' }
                  : undefined
              }
              data-testid={`timeframe-${tf.days}`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {loading ? '...' : `${total.toLocaleString()} products`}
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
                <div className="flex-1">
                  <div className="h-3 bg-muted rounded w-48" />
                </div>
                <div className="h-3 bg-muted rounded w-16" />
                <div className="h-3 bg-muted rounded w-16" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty */}
      {!loading && products.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-sm">No products found for this niche/timeframe.</p>
        </div>
      )}

      {/* Table */}
      {!loading && products.length > 0 && (
        <>
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm" data-testid="products-table">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left py-3 px-4 font-medium text-xs w-12">#</th>
                  <th className="text-left py-3 px-4 font-medium text-xs min-w-[240px]">Product</th>
                  <th className="text-right py-3 px-4 font-medium text-xs">Revenue</th>
                  <th className="text-right py-3 px-4 font-medium text-xs">Units Sold</th>
                  <th className="text-right py-3 px-4 font-medium text-xs">Stock</th>
                  <th className="text-right py-3 px-4 font-medium text-xs">Rating</th>
                  <th className="text-right py-3 px-4 font-medium text-xs">Reviews</th>
                  <th className="text-right py-3 px-4 font-medium text-xs">Price</th>
                  <th className="text-left py-3 px-4 font-medium text-xs min-w-[180px]">Top Videos</th>
                  <th className="py-3 px-4 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.map((product, idx) => {
                  const rank = (page - 1) * limit + idx + 1;
                  const revenue = (product.sold_count || 0) * (product.sale_price || 0);
                  const topVids = videoMap[product.product_id] || [];
                  const bookmarked = isProductBookmarked(product.product_id);

                  return (
                    <tr
                      key={product.product_id}
                      className="hover:bg-secondary/30 transition-colors"
                      data-testid={`product-row-${product.product_id}`}
                    >
                      {/* Rank */}
                      <td className="py-3 px-4">
                        <span
                          className="inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono font-bold"
                          style={
                            rank <= 3
                              ? { backgroundColor: '#a3ff00', color: '#0a0a0c' }
                              : { backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }
                          }
                        >
                          {rank}
                        </span>
                      </td>

                      {/* Product */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          {product.image_url ? (
                            <img
                              src={product.image_url}
                              alt=""
                              className="w-10 h-10 rounded object-cover border border-border flex-shrink-0"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded bg-muted flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground line-clamp-2 leading-snug">
                              {product.title}
                            </p>
                            {product.product_url && (
                              <a
                                href={product.product_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] text-[#a3ff00] hover:underline mt-0.5"
                              >
                                <ExternalLink size={9} />
                                View
                              </a>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Revenue */}
                      <td className="py-3 px-4 text-right">
                        <span className="font-mono text-xs font-semibold text-[#a3ff00]">
                          {formatRevenue(revenue)}
                        </span>
                      </td>

                      {/* Units Sold */}
                      <td className="py-3 px-4 text-right">
                        <span className="font-mono text-xs text-foreground">
                          {(product.sold_count || 0).toLocaleString()}
                        </span>
                      </td>

                      {/* Stock */}
                      <td className="py-3 px-4 text-right">
                        <span className="font-mono text-xs text-muted-foreground">
                          {(product.stock_quantity || 0).toLocaleString()}
                        </span>
                      </td>

                      {/* Rating */}
                      <td className="py-3 px-4 text-right">
                        <div className="inline-flex items-center gap-1">
                          <Star size={10} className="text-yellow-500 fill-yellow-500" />
                          <span className="font-mono text-xs text-foreground">
                            {(product.rating || 0).toFixed(1)}
                          </span>
                        </div>
                      </td>

                      {/* Reviews */}
                      <td className="py-3 px-4 text-right">
                        <span className="font-mono text-xs text-muted-foreground">
                          {(product.review_count || 0).toLocaleString()}
                        </span>
                      </td>

                      {/* Price */}
                      <td className="py-3 px-4 text-right">
                        <span className="font-mono text-xs font-medium text-foreground">
                          ${(product.sale_price || 0).toFixed(2)}
                        </span>
                      </td>

                      {/* Top Videos thumbnails */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          {topVids.slice(0, 5).map((vid) => (
                            <a
                              key={vid.id}
                              href={vid.video_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block flex-shrink-0"
                            >
                              {vid.cover_image_url ? (
                                <img
                                  src={vid.cover_image_url}
                                  alt=""
                                  className="w-8 h-8 rounded object-cover border border-border hover:border-primary/50 transition-colors"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-8 h-8 rounded bg-muted border border-border" />
                              )}
                            </a>
                          ))}
                          {topVids.length === 0 && (
                            <span className="text-[10px] text-muted-foreground">--</span>
                          )}
                        </div>
                      </td>

                      {/* Bookmark */}
                      <td className="py-3 px-4">
                        <button
                          onClick={() => toggleProductBookmark(product)}
                          className="w-7 h-7 rounded flex items-center justify-center hover:bg-secondary transition-colors"
                          data-testid={`bookmark-product-${product.product_id}`}
                        >
                          <Bookmark
                            size={14}
                            className={
                              bookmarked
                                ? 'text-[#a3ff00] fill-[#a3ff00]'
                                : 'text-muted-foreground'
                            }
                          />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6 mb-4">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
                data-testid="page-prev"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-mono text-muted-foreground px-3">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="h-9 w-9 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
                data-testid="page-next"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
