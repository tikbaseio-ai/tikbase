import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend, MIN_PRIOR_UNITS, type SoldPoint } from '../api/_lib/trend-math';

const TODAY = '2026-11-12';
const day = (n: number) => new Date(Date.parse(TODAY + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

/** daily snapshots from `from` days ago to today, cumulative rising by perDay(i) */
function series(from: number, perDay: (daysAgo: number) => number, start = 1000): SoldPoint[] {
  const out: SoldPoint[] = [];
  let sold = start;
  for (let n = from; n >= 0; n--) {
    sold += perDay(n);
    out.push({ date: day(n), sold, price: 10 });
  }
  return out;
}

test('no rows is no-history with every figure null, not zero', () => {
  const t = computeTrend([], 7, TODAY);
  assert.equal(t.status, 'no-history');
  assert.equal(t.growth, null);
  assert.equal(t.units, null);
});

test('doubling sales over equal windows is +100%', () => {
  // 10/day for the prior 7 days, 20/day for the latest 7
  const t = computeTrend(series(30, (n) => (n < 7 ? 20 : 10)), 7, TODAY);
  assert.equal(t.status, 'ok');
  assert.equal(t.units, 140);
  assert.equal(t.priorUnits, 70);
  assert.equal(t.growth, 1);
});

test('a decline is negative growth, kept as a number', () => {
  const t = computeTrend(series(30, (n) => (n < 7 ? 5 : 10)), 7, TODAY);
  assert.equal(t.growth, -0.5);
});

test('a zero reading is a missing reading, not a product that sold nothing', () => {
  const rows = series(30, () => 10);
  rows[0] = { ...rows[0], sold: 0 }; // first-ever snapshot failed to read
  const t = computeTrend(rows, 30, TODAY);
  // 30d needs 60d of history; only ~29 days remain once the 0 is dropped.
  assert.equal(t.status, 'short-history');
  assert.equal(t.growth, null);
});

test('history shorter than two windows reports the current window and no growth', () => {
  const t = computeTrend(series(10, () => 10), 7, TODAY);
  assert.equal(t.status, 'short-history');
  assert.equal(t.units, 70);
  assert.equal(t.growth, null);
});

test('a tiny prior base is refused rather than printed as a huge percentage', () => {
  const t = computeTrend(series(30, (n) => (n < 7 ? 5 : n < 14 ? 1 : 10)), 7, TODAY);
  assert.ok(7 < MIN_PRIOR_UNITS);
  assert.equal(t.status, 'too-few-sales');
  assert.equal(t.growth, null);
});

test('a newest snapshot older than a week is stale, not "recent"', () => {
  const rows = series(60, () => 10).filter((p) => p.date <= day(10));
  const t = computeTrend(rows, 7, TODAY);
  assert.equal(t.status, 'stale');
  assert.equal(t.growth, null);
});

test('a gap up to a week is bridged; a longer one leaves the edge unknown', () => {
  const bridged = series(30, () => 10).filter((p) => ![day(7), day(8), day(9)].includes(p.date));
  assert.equal(computeTrend(bridged, 7, TODAY).status, 'ok');

  const holed = series(30, () => 10).filter((p) => p.date > day(7) || p.date < day(20));
  assert.equal(computeTrend(holed, 7, TODAY).status, 'short-history');
});

test('sold_count dropping (TikTok correction) never yields negative units', () => {
  const rows = series(30, () => 10);
  rows[rows.length - 1] = { ...rows[rows.length - 1], sold: rows[rows.length - 2].sold - 50 };
  const t = computeTrend(rows, 7, TODAY);
  assert.ok(t.points.every((p) => p.u >= 0));
  assert.ok((t.units ?? 0) >= 0);
});

test('points carry per-day units and an estimated revenue from the snapshot price', () => {
  const t = computeTrend(series(30, () => 10), 7, TODAY);
  const last = t.points[t.points.length - 1];
  assert.equal(last.u, 10);
  assert.equal(last.r, 100);
  assert.equal(last.gap, 1);
});

test('a snapshot without a price gives no revenue figure for that day', () => {
  const rows = series(30, () => 10).map((p) => ({ ...p, price: null }));
  const t = computeTrend(rows, 7, TODAY);
  assert.equal(t.points[0].r, null);
});
