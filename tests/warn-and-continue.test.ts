/**
 * The three WARN-and-continue sites, each with its failure simulated.
 *
 * Lives in tests/, not api/: everything under api/ is deployed as a serverless
 * function, so this file was being published as an endpoint at
 * /api/warn-and-continue.test — one that imports node:test and cannot run.
 *
 * Run with `npm test`. No network, no database: every case drives the real
 * exported function against a fake Supabase that fails on demand, because the
 * behaviour under test only happens when something breaks.
 *
 * What each is protecting:
 *   product_view_stats — a timed-out chunk used to publish its products with
 *                        0 views, which reads as "nobody watched this" and is
 *                        what decides whether a product ranks at all.
 *   refund             — a failed refund silently kept a credit reserved, so
 *                        the day's cap drained without buying anything.
 *   cache write        — a failed write meant the next click paid the vendor
 *                        again for bytes already in hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchViewStats, rpcWithRetry } from '../api/top-products';
import { refundCredit, cacheTranscript } from '../api/video-transcript';

/** Fake PostgREST. `failures` is per-rpc-name: how many calls fail first. */
function fakeSupabase(opts: {
  failures?: Record<string, number>;
  rows?: Record<string, any[]>;
  upsertFailures?: number;
} = {}) {
  const calls: string[] = [];
  const failures = { ...(opts.failures || {}) };
  let upsertFailures = opts.upsertFailures ?? 0;
  const upserts: any[] = [];

  return {
    calls,
    upserts,
    async rpc(fn: string, _args?: any) {
      calls.push(fn);
      if (failures[fn] > 0) {
        failures[fn]--;
        return { data: null, error: { message: `simulated ${fn} timeout` } };
      }
      return { data: opts.rows?.[fn] ?? [], error: null };
    },
    from(_table: string) {
      return {
        upsert(row: any) {
          upserts.push(row);
          if (upsertFailures > 0) {
            upsertFailures--;
            return Promise.resolve({ error: { message: 'simulated write failure' } });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  } as any;
}

// --- 1. product_view_stats ---------------------------------------------------

test('rpcWithRetry: a transient failure is retried and recovers', async () => {
  const db = fakeSupabase({ failures: { product_view_stats: 1 } });
  const res = await rpcWithRetry(db, 'product_view_stats', {}, 'test');
  assert.equal(res.error, null);
  assert.equal(res.attempts, 2);
});

test('view stats: a chunk that fails ONCE recovers, nothing is marked unknown', async () => {
  const db = fakeSupabase({
    failures: { product_view_stats: 1 },
    rows: {
      product_view_stats: [
        { product_id: 'a', period_views: 500, period_video_count: 2, total_views: 900, video_count: 3 },
      ],
    },
  });
  const { stats, unknown } = await fetchViewStats(db, ['a'], 30);
  assert.equal(unknown.size, 0, 'a recovered chunk must not be marked unknown');
  assert.equal(stats.get('a')?.periodViews, 500);
});

test('view stats: a chunk that fails TWICE marks its products unknown, never zero', async () => {
  const ids = ['a', 'b', 'c'];
  const db = fakeSupabase({ failures: { product_view_stats: 2 } });
  const { stats, unknown } = await fetchViewStats(db, ids, 30);

  for (const id of ids) {
    assert.ok(unknown.has(id), `${id} must be marked unknown`);
    // The critical assertion: no zeroed entry is left behind for the estimator
    // to read as "no views".
    assert.equal(stats.get(id), undefined, `${id} must have no stats entry at all`);
  }
});

test('view stats: an empty answer is a real zero, not an unknown', async () => {
  // The RPC returning no row for a product means it has no videos. That is a
  // measurement, and it must stay distinguishable from a failed read.
  const db = fakeSupabase({ rows: { product_view_stats: [] } });
  const { stats, unknown } = await fetchViewStats(db, ['a'], 30);
  assert.equal(unknown.size, 0);
  assert.equal(stats.size, 0);
});

test('view stats: a failed top-videos chunk costs thumbnails, not correctness', async () => {
  const db = fakeSupabase({
    failures: { product_top_videos: 2 },
    rows: {
      product_view_stats: [
        { product_id: 'a', period_views: 10, period_video_count: 1, total_views: 10, video_count: 1 },
      ],
    },
  });
  const { stats, unknown, videos } = await fetchViewStats(db, ['a'], 30);
  assert.equal(unknown.size, 0, 'thumbnails failing must not mark views unknown');
  assert.equal(stats.get('a')?.periodViews, 10);
  assert.deepEqual(videos, {});
});

test('view stats: chunking splits the id list', async () => {
  // 120 ids at a chunk size of 50 is 3 chunks, and each chunk makes 2 calls.
  const db = fakeSupabase({ rows: { product_view_stats: [] } });
  await fetchViewStats(db, Array.from({ length: 120 }, (_, i) => `p${i}`), 30);
  assert.equal(db.calls.filter((c: string) => c === 'product_view_stats').length, 3);
  assert.equal(db.calls.filter((c: string) => c === 'product_top_videos').length, 3);
});

// --- 2. refund ---------------------------------------------------------------

test('refund: a transient failure is retried and succeeds', async () => {
  const db = fakeSupabase({ failures: { transcript_refund: 1 } });
  const res = await refundCredit(db, 'vid-1');
  assert.deepEqual(res, { refunded: true, attempts: 2 });
  assert.deepEqual(db.calls, ['transcript_refund', 'transcript_refund']);
});

test('refund: a double failure records the phantom credit', async () => {
  const db = fakeSupabase({ failures: { transcript_refund: 2 } });
  const res = await refundCredit(db, 'vid-2');
  assert.equal(res.refunded, false);
  assert.equal(res.attempts, 2);
  // The whole point: the un-refunded credit is counted, so the next spend can
  // hand back exactly one and the cap stops draining silently.
  assert.equal(
    db.calls.filter((c: string) => c === 'transcript_note_unrefunded').length,
    1,
  );
});

test('refund: if the note ALSO fails, it degrades rather than throwing', async () => {
  const db = fakeSupabase({
    failures: { transcript_refund: 2, transcript_note_unrefunded: 1 },
  });
  const res = await refundCredit(db, 'vid-3');
  assert.equal(res.refunded, false);
});

test('refund: a first-attempt success makes no second call', async () => {
  const db = fakeSupabase();
  const res = await refundCredit(db, 'vid-4');
  assert.deepEqual(res, { refunded: true, attempts: 1 });
  assert.deepEqual(db.calls, ['transcript_refund']);
});

// --- 3. transcript cache write ----------------------------------------------

test('cache write: a transient failure is retried and succeeds', async () => {
  const db = fakeSupabase({ upsertFailures: 1 });
  const res = await cacheTranscript(db, { video_id: 'vid-5', status: 'ok' });
  assert.deepEqual(res, { cached: true, attempts: 2 });
  assert.equal(db.upserts.length, 2);
});

test('cache write: a double failure reports it instead of claiming success', async () => {
  const db = fakeSupabase({ upsertFailures: 2 });
  const res = await cacheTranscript(db, { video_id: 'vid-6', status: 'ok' });
  assert.deepEqual(res, { cached: false, attempts: 2 });
  // The caller still has the transcript in hand and serves it — the contract is
  // that it must KNOW the write failed, which is what `cached: false` carries.
});

test('cache write: the row is passed through unchanged', async () => {
  const db = fakeSupabase();
  const row = { video_id: 'vid-7', status: 'ok', webvtt: 'WEBVTT', credits_spent: 1 };
  await cacheTranscript(db, row);
  assert.deepEqual(db.upserts[0], row);
});
