import test from 'node:test';
import assert from 'node:assert/strict';
import { exportColumns } from '../api/export-products';
import { toCsv } from '../api/_lib/csv';

test('export leaves unknowns empty and never prints 0 for a missing figure', () => {
  const row: any = {
    product_id: '1729000000001',
    title: '=cmd|"x"',
    sale_price: 0, // unknown price
    sold_count: 0,
    metrics: { estPeriodUnitsSold: 12, estRevenue: 0, hasRealDelta: false, periodViews: null },
    windows: { '7': null, '30': { revenue: 120.456, unitsSold: 12, hasRealDelta: true, hasRealPrice: true } },
    distinct_creators: 0, // a real zero
    affiliate_intensity: null,
    created_at: '2026-10-01T05:00:00Z',
    trend: { status: 'short-history', units: 30, priorUnits: null, growth: null },
  };
  const csv = toCsv(exportColumns(7, 30), [row]);
  const [head, line] = csv.replace('﻿', '').trim().split('\r\n');
  const h = head.split(',');
  const cell = (name: string) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[h.indexOf(name)];
  assert.equal(cell('rank'), '1');
  assert.equal(cell('price_usd'), '');
  assert.equal(cell('est_revenue_30d_usd'), '');
  assert.equal(cell('revenue_7d_usd'), '');
  assert.equal(cell('revenue_30d_usd'), '120.46');
  assert.equal(cell('creators_30d'), '0');
  assert.equal(cell('growth_7d_pct'), '');
  assert.equal(cell('trend_status_7d'), 'short-history');
  assert.equal(cell('affiliate_video_share_pct'), '');
  assert.equal(cell('first_seen_by_tikbase'), '2026-10-01');
  assert.ok(cell('title').startsWith(`"'=cmd`));
});
