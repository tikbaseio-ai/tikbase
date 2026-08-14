/**
 * Is the backend actually there?
 *
 * WHY THIS EXISTS. When the Supabase project is restricted — right now it is,
 * for `exceed_egress_quota` — every layer fails differently and most of them
 * fail QUIETLY. Measured against the live outage on 2026-08-09:
 *
 *   GET /api/top-products    200  {"products":[],"total":0}   <- "no products"
 *   GET /api/check-subscription 200  {"isPaid":false}         <- Pro user, downgraded
 *   GET /api/brand-search    500  {"error":"Search failed"}
 *   POST /auth/v1/token      402  exceed_egress_quota          <- login just fails
 *
 * The first two are the dangerous ones: a 200 carrying an empty list is not an
 * error the UI can catch, it is a false statement about the catalogue, and a
 * paying customer silently seeing the free tier is worse. So the check cannot
 * be "did a request fail" — it has to be "is the project reachable at all",
 * asked before any of that is rendered.
 *
 * /auth/v1/health is the probe: it answers 402 with the restriction message
 * when the project is capped, and it reads no rows from the database, so the
 * maintenance path costs zero DB work. Verified against this outage.
 *
 * Two ways in, because a restriction can also begin mid-session:
 *   1. one probe at boot, before the app renders anything,
 *   2. a latch on any 402 seen by any fetch (see installFetchGuard).
 *
 * Once latched the app renders the maintenance screen and stops issuing data
 * requests entirely; a probe every 60s is the only traffic, so the app comes
 * back on its own when the quota resets.
 */

const SUPABASE_URL = 'https://ntapskfgodvynlfyulnv.supabase.co';
// The same public anon key the app already ships. Two details, both measured:
//   - without a key the endpoint answers 401 BEFORE the restriction check runs,
//     so a capped project looks healthy. That is how the first version of this
//     file failed its own test.
//   - the key goes in the query string, not an `apikey` header. A custom header
//     makes this a preflighted request, which doubles the probe and makes it
//     depend on the OPTIONS response as well. As a query param it is a simple
//     GET: one request, no preflight. Verified: both forms return 402 today.
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50YXBza2Znb2R2eW5sZnl1bG52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MzEyNzUsImV4cCI6MjA4OTIwNzI3NX0.jOA-9kwBrOsfc8uqFFcyp0PajoKl9HQcRmaliYELBQo';
const HEALTH_URL = `${SUPABASE_URL}/auth/v1/health?apikey=${ANON_KEY}`;
const RECHECK_MS = 60_000;
/** A probe that hangs must not hold the app on a blank screen. */
const PROBE_TIMEOUT_MS = 6_000;

export type ServiceState = 'ok' | 'restricted';

let state: ServiceState = 'ok';
let recheckTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(s: ServiceState) => void>();

export function getServiceState(): ServiceState {
  return state;
}

export function subscribeServiceState(fn: (s: ServiceState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(next: ServiceState) {
  if (next === state) return;
  state = next;
  for (const fn of listeners) fn(next);
}

/**
 * Latch on a response that proves the project is restricted.
 *
 * 402 is the whole signal. It is not a status this app's own endpoints ever
 * return — the only 402 in the codebase is the ScrapeCreators credit wall,
 * which is server-side and never reaches a browser — so there is nothing to
 * disambiguate.
 */
export function reportStatus(status: number): void {
  if (status === 402) setState('restricted');
}

/**
 * One probe. Never throws; an unreachable network is not a restriction.
 *
 * Concurrent callers share the in-flight request. Without that, a boot fires
 * four: StrictMode mounts the app twice and the maintenance screen checks once
 * more on its own mount.
 */
let inFlight: Promise<ServiceState> | null = null;

export function probeService(): Promise<ServiceState> {
  if (!inFlight) inFlight = runProbe().finally(() => { inFlight = null; });
  return inFlight;
}

async function runProbe(): Promise<ServiceState> {
  try {
    const res = await fetch(HEALTH_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    setState(res.status === 402 ? 'restricted' : 'ok');
  } catch {
    // Offline, DNS, a timeout: all indistinguishable from a browser, and none
    // of them mean the project is capped. Leave the state alone rather than
    // showing a maintenance page to someone whose wifi dropped.
  }
  return state;
}

/**
 * Wrap window.fetch once so every call site is covered without touching any of
 * them, and so nothing keeps hammering a database that is not answering.
 */
export function installFetchGuard(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // While restricted, data requests are not attempted at all — that is the
    // "zero DB calls" part. The probe itself is exempt, or the app could never
    // discover that the outage is over.
    if (state === 'restricted' && !url.startsWith(HEALTH_URL) && isDataRequest(url)) {
      return new Response(JSON.stringify({ error: 'service_unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const res = await original(input as any, init);
    reportStatus(res.status);
    return res;
  };
}

function isDataRequest(url: string): boolean {
  return url.includes('/api/') || url.includes(SUPABASE_URL);
}

/** Probe at boot, then keep checking so recovery needs no page reload. */
export function startServiceWatch(): void {
  void probeService();
  if (recheckTimer) return;
  recheckTimer = setInterval(() => { void probeService(); }, RECHECK_MS);
}
