import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import {
  Command, CommandGroup, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command';
import { authHeader } from '@/lib/supabase';
import { Search, Loader2, PackageSearch, AlertCircle } from 'lucide-react';
import { productDetailPath } from '@/components/ProductSearch';
import { creatorProfilePath } from '@/components/CreatorSearch';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;
/** Per section, so both fit on screen without scrolling past the second group. */
const PER_SECTION = 6;

interface ProductHit {
  product_id: string;
  title: string;
  seller_name: string | null;
  image_url: string;
  sale_price: number | null;
  sold_count: number;
  has_ranking_data: boolean;
}
interface CreatorHit {
  creator_key: string;
  display_name: string | null;
  handle: string | null;
  avatar_url: string;
  videos_count: number;
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/**
 * One search box over both catalogues.
 *
 * Products and creators are separate endpoints, so this fires both on the SAME
 * debounce and renders them as two sections inside a single cmdk list. One list
 * is what makes arrow keys walk from the last product into the first creator —
 * two independent widgets could not do that.
 *
 * MISS CAPTURE, and why the request carries a flag. api/product-search records
 * a zero-result search as a coverage gap. That is right for a product search box
 * and wrong for this one: typing a creator's name would log a phantom "missing
 * product" on every keystroke. So the combined search suppresses recording, and
 * reports the miss explicitly only when BOTH sections come back empty — which is
 * the only case where the user actually failed to find anything.
 */
export default function GlobalSearch() {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<ProductHit[]>([]);
  const [creators, setCreators] = useState<CreatorHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setProducts([]); setCreators([]);
      setLoading(false); setError(false); setRateLimited(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const headers = await authHeader();
        // Both on one debounce. suppress_miss keeps the product endpoint from
        // logging a coverage gap before we know whether creators matched.
        const [pRes, cRes] = await Promise.all([
          fetch(`/api/product-search?q=${encodeURIComponent(q)}&suppress_miss=1`, { headers }),
          fetch(`/api/creator-search?q=${encodeURIComponent(q)}`, { headers }),
        ]);
        if (cancelled) return;

        if (pRes.status === 429 || cRes.status === 429) {
          setRateLimited(true); setProducts([]); setCreators([]); setError(false);
          return;
        }
        if (!pRes.ok && !cRes.ok) throw new Error('search failed');

        // One side failing should not blank the other.
        const pJson = pRes.ok ? await pRes.json() : { results: [] };
        const cJson = cRes.ok ? await cRes.json() : { results: [] };
        const p = (pJson.results || []).slice(0, PER_SECTION);
        const c = (cJson.results || []).slice(0, PER_SECTION);
        setProducts(p); setCreators(c);
        setError(false); setRateLimited(false);

        // Only now, knowing both missed, is this a real unmet need.
        if (p.length === 0 && c.length === 0) {
          void fetch(
            `/api/product-search?q=${encodeURIComponent(q)}&report_miss=1`,
            { headers },
          ).catch(() => {});
        }
      } catch {
        if (!cancelled) { setError(true); setProducts([]); setCreators([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const go = useCallback((path: string) => {
    setOpen(false); setQuery(''); inputRef.current?.blur();
    navigate(path);
  }, [navigate]);

  const q = query.trim();
  const showPanel = open && q.length >= MIN_QUERY;
  const bothEmpty = products.length === 0 && creators.length === 0;

  return (
    <div ref={boxRef} className="relative w-full max-w-xl" data-testid="global-search">
      {/* shouldFilter={false}: both sides are ranked server-side. cmdk's fuzzy
          filter would re-order what SQL deliberately ordered. */}
      <Command shouldFilter={false} className="overflow-visible bg-transparent">
        <div className="flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-card focus-within:ring-1 focus-within:ring-primary">
          <Search size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault(); setOpen(false); inputRef.current?.blur();
              }
            }}
            placeholder="Search products and creators"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            data-testid="global-search-input"
          />
          {loading && <Loader2 size={13} className="text-muted-foreground animate-spin" />}
        </div>

        {showPanel && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg overflow-hidden">
            <CommandList className="max-h-[420px]">
              {rateLimited && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <AlertCircle size={13} /> Too many searches — try again in a moment.
                </div>
              )}

              {!rateLimited && error && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <AlertCircle size={13} /> Search is unavailable right now.
                </div>
              )}

              {/* Fires only when BOTH sections missed — a query that finds a
                  creator but no product is a hit, not a dead end. */}
              {!rateLimited && !error && !loading && bothEmpty && (
                <div className="px-3 py-4" data-testid="global-search-empty">
                  <div className="flex items-center gap-2 text-xs text-foreground">
                    <PackageSearch size={13} />
                    Nothing matches “{q}” yet.
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5 pl-[21px]">
                    We logged it — searches that come up empty are what we use to decide
                    what to pull in next.
                  </p>
                </div>
              )}

              {!rateLimited && !error && products.length > 0 && (
                <CommandGroup
                  heading="Products"
                  className="p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {products.map(r => (
                    <CommandItem
                      key={`p-${r.product_id}`}
                      value={`product-${r.product_id}`}
                      onSelect={() => go(productDetailPath(r.product_id))}
                      className="flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer aria-selected:bg-secondary"
                      data-testid={`global-hit-product-${r.product_id}`}
                    >
                      <img src={r.image_url} alt="" loading="lazy"
                        className="h-8 w-8 rounded object-cover bg-secondary flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground truncate">{r.title}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {r.seller_name || 'Unknown shop'}
                          {r.sold_count > 0 && <span className="font-mono"> · {compact(r.sold_count)} sold</span>}
                        </div>
                      </div>
                      {r.has_ranking_data && (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-[#a3ff00]/40 text-[#a3ff00] bg-[#a3ff00]/10 flex-shrink-0"
                          title="Ranked in the last 30 days — this product has revenue data."
                        >
                          Ranked
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {!rateLimited && !error && products.length > 0 && creators.length > 0 && (
                <CommandSeparator />
              )}

              {!rateLimited && !error && creators.length > 0 && (
                <CommandGroup
                  heading="Creators"
                  className="p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {creators.map(r => {
                    const name = r.display_name || r.handle || r.creator_key;
                    return (
                      <CommandItem
                        key={`c-${r.creator_key}`}
                        value={`creator-${r.creator_key}`}
                        onSelect={() => go(creatorProfilePath(r.creator_key))}
                        className="flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer aria-selected:bg-secondary"
                        data-testid={`global-hit-creator-${r.creator_key}`}
                      >
                        <img src={r.avatar_url} alt="" loading="lazy"
                          className="h-8 w-8 rounded-full object-cover bg-secondary flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-foreground truncate">{name}</div>
                          {r.handle && (
                            <div className="text-[11px] text-muted-foreground font-mono truncate">@{r.handle}</div>
                          )}
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0">
                          {compact(r.videos_count)} video{r.videos_count === 1 ? '' : 's'}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </div>
        )}
      </Command>
    </div>
  );
}
