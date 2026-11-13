import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, type PoolRow } from '../api/_lib/presets';
import type { Trend } from '../api/_lib/trend-math';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const trend = (growth: number | null, units = 100, status: Trend['status'] = 'ok'): Trend => ({
  range: 7, status, asOf: '2026-11-12', historyDays: 60,
  units, priorUnits: 50, growth: status === 'ok' ? growth : null, points: [],
});
const row = (id: string, o: Partial<PoolRow> = {}): PoolRow => ({
  product_id: id,
  created_at: '2026-03-01T00:00:00Z',
  metrics: { estRevenue: 1000, hasRealDelta: true },
  distinct_creators: 5,
  affiliate_intensity: 0.5,
  ...o,
});

test('rapid growth: needs the growth AND the volume, fastest first', () => {
  const pool = [row('a'), row('b'), row('c'), row('d')];
  const trends = new Map([
    ['a', trend(0.6)],
    ['b', trend(2.0)],
    ['c', trend(5.0, 5)], // huge % on 5 units: excluded
    ['d', trend(0.2)], // below the bar
  ]);
  const r = applyPreset('rapid-growth', pool, trends, 7, NOW);
  assert.deepEqual(r.rows.map((x) => x.product_id), ['b', 'a']);
});

test('products with no measurable history are counted as unevaluated, not as flat', () => {
  const pool = [row('a'), row('b'), row('c')];
  const trends = new Map([['a', trend(1)], ['b', trend(null, 0, 'no-history')]]);
  const r = applyPreset('rapid-growth', pool, trends, 7, NOW);
  assert.equal(r.evaluated, 1);
  assert.equal(r.unevaluated, 2);
});

test('high potential: low creators, measured sales, commissioned videos, not shrinking', () => {
  const pool = [
    row('good', { distinct_creators: 2 }),
    row('crowded', { distinct_creators: 400 }),
    row('estimated', { distinct_creators: 2, metrics: { estRevenue: 1000, hasRealDelta: false } }),
    row('shrinking', { distinct_creators: 2 }),
    row('no-commission', { distinct_creators: 2, affiliate_intensity: 0 }),
    row('unknown-intensity', { distinct_creators: 2, affiliate_intensity: null }),
  ];
  const trends = new Map(pool.map((p) => [p.product_id, trend(0.1)]));
  trends.set('shrinking', trend(-0.3));
  const r = applyPreset('high-potential', pool, trends, 7, NOW);
  assert.deepEqual(r.rows.map((x) => x.product_id), ['good']);
});

test('high potential ranks by revenue per creator', () => {
  const pool = [
    row('a', { distinct_creators: 4, metrics: { estRevenue: 4000, hasRealDelta: true } }),
    row('b', { distinct_creators: 1, metrics: { estRevenue: 4000, hasRealDelta: true } }),
  ];
  const trends = new Map(pool.map((p) => [p.product_id, trend(0)]));
  const r = applyPreset('high-potential', pool, trends, 7, NOW);
  assert.deepEqual(r.rows.map((x) => x.product_id), ['b', 'a']);
});

test('new: only products first seen inside 30 days, by revenue', () => {
  const pool = [
    row('old'),
    row('n1', { created_at: '2026-11-01T00:00:00Z', metrics: { estRevenue: 10, hasRealDelta: false } }),
    row('n2', { created_at: '2026-10-20T00:00:00Z', metrics: { estRevenue: 90, hasRealDelta: false } }),
    row('nodate', { created_at: null }),
  ];
  const r = applyPreset('new', pool, new Map(), 7, NOW);
  assert.deepEqual(r.rows.map((x) => x.product_id), ['n2', 'n1']);
});
