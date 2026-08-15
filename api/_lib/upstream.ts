/**
 * Telling "no" apart from "I could not ask".
 *
 * Both of these endpoints used to answer 200 with a confident-looking lie when
 * the database was unreachable. Measured against the live Supabase outage on
 * 2026-08-09:
 *
 *   GET /api/check-subscription  200 {"isPaid":false}    <- a Pro customer
 *   GET /api/top-products        200 {"products":[]}     <- "no products"
 *
 * The first one is the one that costs money and trust: a paying customer is
 * told they are not paying because Postgres is down, and the UI dutifully
 * paywalls them. An empty catalogue is the same error in a different suit — it
 * is not an error the client can catch, it is a false statement about the data.
 *
 * So: when the failure is upstream, say 503. A 503 is a fact ("ask again"); a
 * 200 carrying a default is a claim.
 */

/** Statuses and messages that mean the backend, not the request, is broken. */
export function isUpstreamOutage(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const status = Number(anyErr.status ?? anyErr.statusCode ?? anyErr.code);
  // 402 is Supabase's project-restricted answer (quota/billing); 5xx and 429
  // are the ordinary unreachable/overloaded shapes.
  if (status === 402 || status === 429 || (status >= 500 && status <= 599)) return true;

  const msg = String(anyErr.message ?? anyErr.error_description ?? anyErr).toLowerCase();
  return (
    msg.includes('exceed_egress_quota') ||
    msg.includes('service for this project is restricted') ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('upstream request timeout') ||
    msg.includes('statement timeout') ||
    msg.includes('canceling statement')
  );
}

export interface UnavailableResponse {
  status: 503;
  body: { error: 'service_unavailable'; reason: 'database_unreachable'; message: string };
  retryAfter: string;
}

export function unavailable(): UnavailableResponse {
  return {
    status: 503,
    body: {
      error: 'service_unavailable',
      reason: 'database_unreachable',
      message: 'We could not reach the database. This is not an answer about your data.',
    },
    retryAfter: '30',
  };
}
