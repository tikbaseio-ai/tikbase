import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { authHeader } from '@/lib/supabase';
import { Search, Loader2, UserX, AlertCircle } from 'lucide-react';

// Server-side minimum. Below this the endpoint returns an empty result set
// rather than an error, so the only thing to do here is not ask.
const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

interface SearchHit {
  creator_key: string;
  display_name: string | null;
  handle: string | null;
  avatar_url: string;
  videos_count: number;
  products_count?: number; // paid only — absent on free responses
}

// Profile URLs carry the raw creator_key, which is 'id:<digits>' for half the
// universe. Encode it: an unescaped ':' in a hash route is ambiguous.
export function creatorProfilePath(key: string): string {
  return `/dashboard/creator/${encodeURIComponent(key)}`;
}

export default function CreatorSearch() {
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced fetch. The cleanup cancels the pending timer AND marks the
  // in-flight response stale, so a slow early keystroke cannot overwrite the
  // results of a later one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setResults([]);
      setLoading(false);
      setError(false);
      setRateLimited(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/creator-search?q=${encodeURIComponent(q)}`,
          { headers: await authHeader() },
        );
        if (cancelled) return;
        if (res.status === 429) {
          setRateLimited(true);
          setResults([]);
          setError(false);
          return;
        }
        if (!res.ok) throw new Error('search failed');
        const data = await res.json();
        setResults(data.results || []);
        setError(false);
        setRateLimited(false);
      } catch {
        if (!cancelled) {
          setError(true);
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Click-away closes the result list. Escape is handled on the input so it
  // works while the list has keyboard focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const go = useCallback(
    (key: string) => {
      setOpen(false);
      setQuery('');
      inputRef.current?.blur();
      navigate(creatorProfilePath(key));
    },
    [navigate],
  );

  const showPanel = open && query.trim().length >= MIN_QUERY;

  return (
    <div ref={boxRef} className="relative w-full max-w-md" data-testid="creator-search">
      {/* shouldFilter={false}: ranking is the server's job (handle prefix, then
          name prefix, then substring, tie-broken by video volume). cmdk's own
          fuzzy filter would re-order what SQL already ranked. */}
      <Command shouldFilter={false} className="overflow-visible bg-transparent">
        <div className="flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-card focus-within:ring-1 focus-within:ring-primary">
          <Search size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                inputRef.current?.blur();
              }
            }}
            placeholder="Search creators by name or @handle"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            data-testid="creator-search-input"
          />
          {loading && <Loader2 size={13} className="text-muted-foreground animate-spin" />}
        </div>

        {showPanel && (
          <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg overflow-hidden">
            <CommandList className="max-h-[340px]">
              {rateLimited && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <AlertCircle size={13} />
                  Too many searches — try again in a moment.
                </div>
              )}

              {!rateLimited && error && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <AlertCircle size={13} />
                  Search is unavailable right now.
                </div>
              )}

              {!rateLimited && !error && !loading && results.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <UserX size={13} />
                  No creators match “{query.trim()}”.
                </div>
              )}

              {!rateLimited && !error && results.length > 0 && (
                <CommandGroup className="p-1">
                  {results.map(r => {
                    const name = r.display_name || r.handle || r.creator_key;
                    return (
                      <CommandItem
                        key={r.creator_key}
                        value={r.creator_key}
                        onSelect={() => go(r.creator_key)}
                        className="flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer aria-selected:bg-secondary"
                        data-testid={`creator-search-hit-${r.creator_key}`}
                      >
                        <img
                          src={r.avatar_url}
                          alt=""
                          loading="lazy"
                          className="h-7 w-7 rounded-full object-cover bg-secondary flex-shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-foreground truncate">{name}</div>
                          {r.handle && (
                            <div className="text-[11px] text-muted-foreground font-mono truncate">
                              @{r.handle}
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0">
                          {r.videos_count.toLocaleString()} video{r.videos_count === 1 ? '' : 's'}
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
