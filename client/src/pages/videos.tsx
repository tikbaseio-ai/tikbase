import { useState, useEffect } from 'react';
import {
  NICHES,
  TIMEFRAMES,
  fetchTopVideos,
  formatViews,
  timeAgo,
  type VideoWithProduct,
} from '@/lib/supabase';
import { useBookmarks } from '@/lib/bookmarks';
import { Bookmark, ExternalLink, Eye, ShoppingBag, ChevronLeft, ChevronRight } from 'lucide-react';

export default function VideosPage() {
  const [niche, setNiche] = useState(NICHES[0].slug);
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[0]);
  const [videos, setVideos] = useState<VideoWithProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const { isVideoBookmarked, toggleVideoBookmark } = useBookmarks();

  const limit = 50;
  const totalPages = Math.ceil(total / limit);

  useEffect(() => {
    setPage(1);
  }, [niche, timeframe]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTopVideos(niche, timeframe.days, page, limit)
      .then(res => {
        if (!cancelled) {
          setVideos(res.videos);
          setTotal(res.total);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [niche, timeframe, page]);

  const nicheLabel = NICHES.find(n => n.slug === niche)?.label || niche;

  return (
    <div className="p-6" data-testid="videos-page">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Top Videos</h1>
        <p className="text-sm text-muted-foreground">
          Trending TikTok Shop videos ranked by views
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Niche dropdown */}
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

        {/* Timeframe pills */}
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

        {/* Result count */}
        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {loading ? '...' : `${total.toLocaleString()} videos`}
        </span>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card animate-pulse">
              <div className="aspect-[9/16] max-h-[280px] bg-muted rounded-t-lg" />
              <div className="p-3 space-y-2">
                <div className="h-3 bg-muted rounded w-2/3" />
                <div className="h-3 bg-muted rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Video grid */}
      {!loading && videos.length === 0 && (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-sm">No videos found for {nicheLabel} in this timeframe.</p>
        </div>
      )}

      {!loading && videos.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {videos.map((video, idx) => {
              const rank = (page - 1) * limit + idx + 1;
              const bookmarked = isVideoBookmarked(video.id);

              return (
                <div
                  key={video.id}
                  className="group rounded-lg border border-border bg-card overflow-hidden hover:border-primary/30 transition-colors"
                  data-testid={`video-card-${video.id}`}
                >
                  {/* Thumbnail */}
                  <div className="relative aspect-[9/16] max-h-[280px] overflow-hidden bg-muted">
                    {video.cover_image_url ? (
                      <img
                        src={video.cover_image_url}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                        No thumbnail
                      </div>
                    )}

                    {/* Rank badge */}
                    <div
                      className="absolute top-2 left-2 px-2 py-0.5 rounded font-mono text-xs font-bold"
                      style={{ backgroundColor: '#a3ff00', color: '#0a0a0c' }}
                    >
                      #{rank}
                    </div>

                    {/* View count overlay */}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-black/70 backdrop-blur-sm">
                      <Eye size={12} className="text-white/80" />
                      <span className="text-[11px] font-mono font-medium text-white">
                        {formatViews(video.view_count || 0)}
                      </span>
                    </div>

                    {/* Bookmark */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        toggleVideoBookmark(video);
                      }}
                      className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors"
                      data-testid={`bookmark-video-${video.id}`}
                    >
                      <Bookmark
                        size={14}
                        className={bookmarked ? 'text-[#a3ff00] fill-[#a3ff00]' : 'text-white/70'}
                      />
                    </button>

                    {/* Video link */}
                    {video.video_url && (
                      <a
                        href={video.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="absolute bottom-2 right-2 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors"
                        data-testid={`link-video-${video.id}`}
                      >
                        <ExternalLink size={12} className="text-white/70" />
                      </a>
                    )}
                  </div>

                  {/* Video info */}
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                      {video.author_avatar_url ? (
                        <img
                          src={video.author_avatar_url}
                          alt=""
                          className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-muted flex-shrink-0" />
                      )}
                      <span className="text-xs font-medium text-foreground truncate">
                        {video.author_name || 'Unknown'}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                        {timeAgo(video.created_at)}
                      </span>
                    </div>

                    {/* Product Analytics */}
                    {video.product && (
                      <div className="pt-2 border-t border-border">
                        <div className="flex items-center gap-1 mb-1.5">
                          <ShoppingBag size={10} className="text-[#a3ff00]" />
                          <span className="text-[10px] font-mono font-semibold tracking-wider text-[#a3ff00] uppercase">
                            Product Analytics
                          </span>
                        </div>
                        <div className="flex items-start gap-2">
                          {video.product.image_url && (
                            <img
                              src={video.product.image_url}
                              alt=""
                              className="w-10 h-10 rounded object-cover flex-shrink-0 border border-border"
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-foreground font-medium leading-snug line-clamp-2">
                              {video.product.title}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-mono text-muted-foreground">
                                {(video.product.sold_count || 0).toLocaleString()} sold
                              </span>
                              {video.product.product_url && (
                                <a
                                  href={video.product.product_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] text-[#a3ff00] hover:underline"
                                >
                                  View
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-8 mb-4">
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
