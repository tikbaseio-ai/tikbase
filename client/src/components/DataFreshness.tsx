import { useEffect, useState } from 'react';

// Keep in step with STALE_AFTER_MS in api/data-freshness.ts. The server sends
// `stale` too; recomputing here means a tab left open past the window does not
// keep a cached "fresh" answer.
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

interface FreshnessBody {
  refreshed_at: string | null;
  stale?: boolean;
}

function formatAsOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function isStale(iso: string | null): boolean {
  if (!iso) return true;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed > STALE_AFTER_MS;
}

/**
 * "Data as of <last published refresh>", plus a warning once that moment is
 * more than 48 hours ago. `marketing` sits on the landing page; `app` is the
 * bar under the dashboard header, on every signed-in page.
 */
export default function DataFreshness({ tone }: { tone: 'marketing' | 'app' }) {
  const [body, setBody] = useState<FreshnessBody | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/data-freshness', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<FreshnessBody>;
      })
      .then((data) => {
        if (!cancelled) setBody(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const iso = body?.refreshed_at ?? null;
  const known = Boolean(iso) && !Number.isNaN(Date.parse(iso || ''));
  // Wait for the request before deciding the data is old. A blank first paint
  // is not a 48-hour warning.
  const settled = body !== null || failed;
  const stale = settled && (failed || !known || isStale(iso));
  const label = known && iso ? formatAsOf(iso) : '—';

  const warning = failed
    ? 'Could not read when this data was last refreshed.'
    : !known
      ? 'The last successful refresh is not recorded.'
      : 'Older than 48 hours. These rankings are not from the latest night.';

  if (tone === 'marketing') {
    return (
      <div className="flex flex-col items-center gap-2" data-testid="data-freshness">
        <p className="font-mono text-sm text-muted-foreground">
          Data as of <time dateTime={iso || undefined}>{label}</time>
        </p>
        {stale && (
          <p className="font-mono text-sm text-warning max-w-md" role="status">
            {warning}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={`border-b px-4 py-2 font-mono text-xs ${
        stale
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-border text-muted-foreground'
      }`}
      data-testid="data-freshness"
      role="status"
    >
      <p className="max-w-5xl">
        Data as of <time dateTime={iso || undefined} className={stale ? 'text-warning' : 'text-foreground'}>{label}</time>
        {stale && <span className="text-foreground"> — {warning}</span>}
      </p>
    </div>
  );
}
