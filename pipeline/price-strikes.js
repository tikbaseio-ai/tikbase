/**
 * price-strikes.js
 *
 * One place deciding when a 404 becomes `price_unavailable = true`.
 *
 * price_unavailable is a hard latch: a flagged product drops out of ranking and
 * out of snapshotting. Both writers — Phase 3 in tikbase-daily-refresh.js and
 * backfill-prices.js — used to set it on a SINGLE 404, with no retry and no
 * confirmation. probes/SNAPSHOT-COVERAGE.md §8 sampled five flagged products
 * live and found one of the five still alive: one transient 404 had removed a
 * selling product from the product permanently.
 *
 * The rule here is two CONSECUTIVE 404s. A 200 anywhere in between wipes the
 * count, so only a product that is missing twice in a row gets latched.
 *
 * Where the count lives: products.price_404_strikes, not the fail-tracker JSON
 * that Phase 4 uses. That file is gitignored and the pipeline runs on a fresh
 * actions/checkout every night — its counts are born empty and die with the
 * runner, so a file-backed strike could never reach two and the latch would
 * simply stop being set. (The same ephemerality means Phase 4's own 3-strike
 * skip has been a no-op on CI since it was written; out of scope here, but it
 * is the same bug.)
 *
 * Transient failures (5xx, timeouts, 402 credit wall) are NOT strikes — they
 * say nothing about the product. That mirrors the credit-wall carve-out
 * already in Phase 4.
 */

/** Consecutive 404s required before the latch is set. */
export const STRIKES_TO_FLAG = 2;

/**
 * The whole decision, as a pure function.
 *
 * @param {number} current  strikes recorded before this fetch
 * @param {'404'|'ok'|'transient'} outcome
 * @returns {{ strikes: number, flag: boolean, changed: boolean }}
 *          strikes: the value to store; flag: set price_unavailable now;
 *          changed: whether anything needs writing at all.
 */
export function nextStrikeState(current, outcome) {
  const now = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;

  if (outcome === '404') {
    const strikes = now + 1;
    return { strikes, flag: strikes >= STRIKES_TO_FLAG, changed: true };
  }

  // A successful fetch is proof of life: reset, but only write if there is
  // something to reset, so a healthy run does not issue 6,000 no-op updates.
  if (outcome === 'ok') {
    return { strikes: 0, flag: false, changed: now > 0 };
  }

  // transient — leave the count exactly where it was.
  return { strikes: now, flag: false, changed: false };
}

/**
 * Group a batch of 404s into "first strike" and "flag now", given the strike
 * counts already stored. Split out from the IO so the boundaries are testable.
 *
 * @param {string[]} deadIds        products that returned 404 this run
 * @param {Map<string,number>} strikesById  stored counts (missing = 0)
 * @returns {{ flag: string[], strike: Array<{id: string, strikes: number}> }}
 */
export function classifyDead(deadIds, strikesById) {
  const flag = [];
  const strike = [];
  for (const id of deadIds) {
    const key = String(id);
    const next = nextStrikeState(strikesById.get(key) ?? 0, '404');
    if (next.flag) flag.push(key);
    else strike.push({ id: key, strikes: next.strikes });
  }
  return { flag, strike };
}

const CHUNK = 500;

function chunked(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Apply a run's 404s: record a strike, and latch only the second one.
 *
 * Returns counts for the caller's summary line. Never throws — a failure to
 * record a strike must not take down a pipeline phase whose real job is
 * snapshots.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} deadIds
 * @returns {Promise<{flagged: number, firstStrike: number, error: string|null}>}
 */
export async function recordDead404s(supabase, deadIds) {
  const result = { flagged: 0, firstStrike: 0, error: null };
  if (!deadIds?.length) return result;

  const ids = [...new Set(deadIds.map(String))];
  const strikesById = new Map();

  try {
    for (const chunk of chunked(ids)) {
      const { data, error } = await supabase
        .from('products')
        .select('product_id, price_404_strikes')
        .in('product_id', chunk);
      if (error) throw new Error(error.message);
      for (const row of data || []) {
        strikesById.set(String(row.product_id), Number(row.price_404_strikes) || 0);
      }
    }

    const { flag, strike } = classifyDead(ids, strikesById);

    for (const chunk of chunked(flag)) {
      const { error } = await supabase
        .from('products')
        .update({ price_unavailable: true, price_404_strikes: STRIKES_TO_FLAG })
        .in('product_id', chunk);
      if (error) throw new Error(error.message);
      result.flagged += chunk.length;
    }

    // Everything on its first strike takes the same value, so one update per
    // chunk covers them.
    const firstIds = strike.filter((s) => s.strikes === 1).map((s) => s.id);
    for (const chunk of chunked(firstIds)) {
      const { error } = await supabase
        .from('products')
        .update({ price_404_strikes: 1 })
        .in('product_id', chunk);
      if (error) throw new Error(error.message);
      result.firstStrike += chunk.length;
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Clear strikes for products that answered this run. Filtered server-side to
 * rows that actually carry a strike, so a healthy run writes nothing.
 *
 * @returns {Promise<{cleared: number, error: string|null}>} cleared is the
 *          number of rows the filter matched, not the number attempted.
 */
export async function clearStrikes(supabase, aliveIds) {
  const result = { cleared: 0, error: null };
  if (!aliveIds?.length) return result;

  try {
    for (const chunk of chunked([...new Set(aliveIds.map(String))])) {
      const { data, error } = await supabase
        .from('products')
        .update({ price_404_strikes: 0 })
        .in('product_id', chunk)
        .gt('price_404_strikes', 0)
        .select('product_id');
      if (error) throw new Error(error.message);
      result.cleared += (data || []).length;
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}
