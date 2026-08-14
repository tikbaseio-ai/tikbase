import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { authHeader } from '@/lib/supabase';
import { Search, Loader2, PackageSearch, AlertCircle } from 'lucide-react';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

interface ProductHit {
  product_id: string;
  title: string;
  seller_name: string | null;
  image_url: string;
  sale_price: number | null;
  sold_count: number;
  niche_slug: string | null;
  has_ranking_data: boolean;
  est_revenue_30d?: number | null; // paid only — absent on free responses
}

export function productDetailPath(productId: string): string {
  return `/dashboard/product/${encodeURIComponent(productId)}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/**
 * Type-ahead over the ~48k product catalogue.
 *
 * Deliberately the same shape as CreatorSearch — debounce, server-side ranking,
 * keyboard navigation, escape-to-close — because two search boxes in one app
 * that behave differently is worse than either behaviour on its own.
 */
export default function ProductSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setResults([]); setLoading(false); setError(false); setRateLimited(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/product-search?q=${encodeURIComponent(q)}`, {
          headers: await authHeader(),
        });
        if (cancelled) return;
        if (res.status === 429) {
          setRateLimited(true); setResults([]); setError(false); return;
        }
        if (!res.ok) throw new Error('search failed');
        const data = await res.json();
        setResults(data.results || []);
        setError(false); setRateLimited(false);
      } catch {
        if (!cancelled) { setError(true); setResults([]); }
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

  const go = useCallback((id: string) => {
    setOpen(false); setQuery(''); inputRef.current?.blur();
    navigate(productDetailPath(id));
  }, [navigate]);

  const showPanel = open && query.trim().length >= MIN_QUERY;
  const q = query.trim();

  return (
    <div ref={boxRef} className="relative w-full max-w-xl" data-testid="product-search">
      {/* shouldFilter={false}: SQL already ranked these (title prefix, then
          seller prefix, then substring, tie-broken by 30d revenue). cmdk's fuzzy
          filter would re-order what the server deliberately ordered. */}
      <Command shouldFilter={false} className="overflow-visible bg-transparent">
        <div className="flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-card focus-within:ring-1 focus-within:ring-primary">
          <Search size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault(); setOpen(false); inputRef.current?.blur();
              }
            }}
            placeholder="Search a product or shop — then see the videos working for it"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            data-testid="product-search-input"
          />
          {loading && <Loader2 size={13} className="text-muted-foreground animate-spin" />}
        </div>

        {showPanel && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg overflow-hidden">
            <CommandList className="max-h-[380px]">
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

              {/* A miss is a real answer, not a failure. It is also recorded
                  server-side as a coverage request, so say so — it sets the
                  expectation that asking was useful. */}
              {!rateLimited && !error && !loading && results.length === 0 && (
                <div className="px-3 py-4" data-testid="product-search-empty">
                  <div className="flex items-center gap-2 text-xs text-foreground">
                    <PackageSearch size={13} />
                    No product matches “{q}” yet.
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5 pl-[21px]">
                    We logged it — searches that come up empty are what we use to decide
                    which products to pull in next.
                  </p>
                </div>
              )}

              {!rateLimited && !error && results.length > 0 && (
                <CommandGroup className="p-1">
                  {results.map(r => (
                    <CommandItem
                      key={r.product_id}
                      value={r.product_id}
                      onSelect={() => go(r.product_id)}
                      className="flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer aria-selected:bg-secondary"
                      data-testid={`product-search-hit-${r.product_id}`}
                    >
                      <img
                        src={r.image_url}
                        alt=""
                        loading="lazy"
                        className="h-9 w-9 rounded object-cover bg-secondary flex-shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground truncate">{r.title}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {r.seller_name || 'Unknown shop'}
                          {r.sold_count > 0 && (
                            <span className="font-mono"> · {compact(r.sold_count)} sold</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Marks a product we actually have ranking data for —
                            the ones whose page will have numbers, not dashes. */}
                        {r.has_ranking_data && (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-primary/40 text-primary-bright bg-primary/10"
                            title="Ranked in the last 30 days — this product has revenue data."
                          >
                            Ranked
                          </span>
                        )}
                        {r.sale_price != null && r.sale_price > 0 && (
                          <span className="text-[11px] font-mono text-muted-foreground">
                            ${r.sale_price.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </div>
        )}
      </Command>
    </div>
  );
}
