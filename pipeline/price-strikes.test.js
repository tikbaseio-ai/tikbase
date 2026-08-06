/**
 * Boundaries of the two-strike rule. Run with `npm test` (node:test, no deps).
 *
 * The thing being protected: price_unavailable is a hard latch that drops a
 * product from ranking and snapshotting, so "one 404 too eager" is a silent
 * data-loss bug and "two 404s never latch" is a silent credit leak. Both edges
 * are asserted here, plus the reset that makes the two CONSECUTIVE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextStrikeState,
  classifyDead,
  recordDead404s,
  clearStrikes,
  STRIKES_TO_FLAG,
} from './price-strikes.js';

test('the rule is two strikes', () => {
  assert.equal(STRIKES_TO_FLAG, 2);
});

test('first 404 records a strike and does NOT flag', () => {
  const s = nextStrikeState(0, '404');
  assert.deepEqual(s, { strikes: 1, flag: false, changed: true });
});

test('second consecutive 404 flags', () => {
  const s = nextStrikeState(1, '404');
  assert.equal(s.strikes, 2);
  assert.equal(s.flag, true);
});

test('a 200 resets the count', () => {
  assert.deepEqual(nextStrikeState(1, 'ok'), { strikes: 0, flag: false, changed: true });
});

test('a 200 on a clean product writes nothing', () => {
  // Otherwise a healthy Phase 3 issues 6,000 no-op updates every night.
  assert.deepEqual(nextStrikeState(0, 'ok'), { strikes: 0, flag: false, changed: false });
});

test('404 -> 200 -> 404 does not flag: the strikes must be consecutive', () => {
  let strikes = nextStrikeState(0, '404').strikes;   // 1
  strikes = nextStrikeState(strikes, 'ok').strikes;  // reset
  const second = nextStrikeState(strikes, '404');
  assert.equal(second.strikes, 1);
  assert.equal(second.flag, false, 'a 200 in between must clear the earlier strike');
});

test('transient failures are not strikes', () => {
  // 5xx, timeouts and the 402 credit wall say nothing about the product.
  assert.deepEqual(nextStrikeState(1, 'transient'), { strikes: 1, flag: false, changed: false });
  assert.deepEqual(nextStrikeState(0, 'transient'), { strikes: 0, flag: false, changed: false });
});

test('an already-flagged product stays flagged on a further 404', () => {
  const s = nextStrikeState(2, '404');
  assert.equal(s.flag, true);
});

test('missing or junk stored counts are treated as zero', () => {
  for (const bad of [undefined, null, NaN, -3, 'x']) {
    assert.equal(nextStrikeState(bad, '404').strikes, 1, `bad input: ${String(bad)}`);
    assert.equal(nextStrikeState(bad, '404').flag, false);
  }
});

test('classifyDead splits a batch on the boundary', () => {
  const stored = new Map([['a', 0], ['b', 1], ['c', 2]]);
  const { flag, strike } = classifyDead(['a', 'b', 'c', 'unseen'], stored);
  assert.deepEqual(flag, ['b', 'c']);
  assert.deepEqual(strike, [{ id: 'a', strikes: 1 }, { id: 'unseen', strikes: 1 }]);
});

// --- IO layer, against a fake Supabase --------------------------------------

// A lazy stand-in for the PostgREST builder: nothing runs until the chain is
// awaited or .select()ed, which is what lets .in(...).gt(...) apply BOTH
// filters — the behaviour clearStrikes depends on.
function fakeSupabase(rows) {
  const writes = [];
  return {
    writes,
    from() {
      const state = { ids: [], gt: null, update: null };

      const matched = () =>
        rows.filter(
          (r) => state.ids.includes(r.product_id) &&
            (state.gt === null || (r.price_404_strikes ?? 0) > state.gt),
        );

      const run = () => {
        const hits = matched();
        if (state.update) {
          for (const r of hits) Object.assign(r, state.update);
          writes.push({ ids: hits.map((h) => h.product_id), fields: state.update });
          return { data: hits.map((h) => ({ product_id: h.product_id })), error: null };
        }
        return { data: hits, error: null };
      };

      const builder = {
        select() { return builder; },
        update(fields) { state.update = fields; return builder; },
        in(_col, ids) { state.ids = ids; return builder; },
        gt(_col, v) { state.gt = v; return builder; },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return builder;
    },
  };
}

test('recordDead404s flags only the products already carrying a strike', async () => {
  const rows = [
    { product_id: 'first-404', price_404_strikes: 0, price_unavailable: false },
    { product_id: 'second-404', price_404_strikes: 1, price_unavailable: false },
  ];
  const db = fakeSupabase(rows);
  const res = await recordDead404s(db, ['first-404', 'second-404']);

  assert.equal(res.error, null);
  assert.equal(res.flagged, 1);
  assert.equal(res.firstStrike, 1);
  assert.equal(rows[0].price_unavailable, false, 'one 404 must not latch');
  assert.equal(rows[0].price_404_strikes, 1);
  assert.equal(rows[1].price_unavailable, true, 'the second consecutive 404 latches');
});

test('recordDead404s reports errors instead of throwing into the pipeline', async () => {
  const boom = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'nope' } }) }) }) };
  const res = await recordDead404s(boom, ['x']);
  assert.equal(res.error, 'nope');
  assert.equal(res.flagged, 0);
});

test('recordDead404s on an empty batch touches nothing', async () => {
  const db = fakeSupabase([]);
  assert.deepEqual(await recordDead404s(db, []), { flagged: 0, firstStrike: 0, error: null });
  assert.equal(db.writes.length, 0);
});

test('clearStrikes only writes rows that carry a strike', async () => {
  const rows = [
    { product_id: 'clean', price_404_strikes: 0 },
    { product_id: 'struck', price_404_strikes: 1 },
  ];
  const db = fakeSupabase(rows);
  const res = await clearStrikes(db, ['clean', 'struck']);

  assert.equal(res.error, null);
  assert.equal(res.cleared, 1);
  assert.equal(rows[1].price_404_strikes, 0);
});
