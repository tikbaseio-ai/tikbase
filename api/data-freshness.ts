// When the catalogue the site is showing was last published.
//
// The collector (pipeline/tikbase-daily-refresh.js) writes refreshed_at when
// a run finishes without a credit wall. precompute-rankings copies that value
// to published_at only after it has rewritten rankings_cache. The pages read
// the cache, so the public stamp is published_at — a collector that finished
// and a precompute that did not must not look like new data.
//
// Older than 48 hours is a warning. "Older than" is strict: a stamp from
// exactly 48 hours ago is still inside the window.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { isUpstreamOutage, unavailable } from './_lib/upstream.js';

export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const STALE_AFTER_HOURS = 48;

export interface FreshnessRow {
  published_at?: string | null;
  refreshed_at?: string | null;
}

export interface FreshnessBody {
  refreshed_at: string | null;
  stale: boolean;
  stale_after_hours: number;
  age_hours: number | null;
}

export function freshnessFromRow(row: FreshnessRow | null, now = Date.now()): FreshnessBody {
  // published_at only. refreshed_at moving forward while published_at stays
  // put is the hours between collection and a failed precompute, and the
  // pages are still on the old cache for all of them.
  const raw = row?.published_at || null;
  const parsed = raw ? Date.parse(raw) : NaN;
  if (!raw || Number.isNaN(parsed)) {
    return {
      refreshed_at: null,
      stale: true,
      stale_after_hours: STALE_AFTER_HOURS,
      age_hours: null,
    };
  }
  const age = now - parsed;
  return {
    refreshed_at: new Date(parsed).toISOString(),
    stale: age > STALE_AFTER_MS,
    stale_after_hours: STALE_AFTER_HOURS,
    age_hours: Math.floor(age / (60 * 60 * 1000)),
  };
}

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '').toLowerCase();
  // The migration has not been applied. That is "no stamp", not an outage —
  // the landing page should say so rather than look like the database is down.
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('data_freshness') ||
    msg.includes('schema cache')
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const down = unavailable();
    res.setHeader('Retry-After', down.retryAfter);
    return res.status(down.status).json(down.body);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from('data_freshness')
    .select('refreshed_at, published_at')
    .eq('id', 'daily-refresh')
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) {
      console.error('data-freshness: table missing —', error.message);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(freshnessFromRow(null));
    }
    console.error(
      'data-freshness:',
      isUpstreamOutage(error) ? 'upstream' : 'query',
      error.message,
    );
    // Not a missing table, so this is "we could not ask". A 200 with a blank
    // stamp would read as "never recorded", which is a different claim.
    const down = unavailable();
    res.setHeader('Retry-After', down.retryAfter);
    return res.status(down.status).json(down.body);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(freshnessFromRow(data as FreshnessRow | null));
}
