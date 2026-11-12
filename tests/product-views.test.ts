import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../api/_lib/product-views';
import { isoDay } from '../api/_lib/trend-math';
import productViews from '../api/product-views';
import exportProducts from '../api/export-products';
import productTrends from '../api/product-trends';

const day = (n: number) => isoDay(Date.now() - n * 86400000);

function payloadRow(id: string, o: any = {}) {
  return {
    product_id: id, title: 'T' + id, created_at: '2026-01-01T00:00:00Z',
    metrics: { estRevenue: 1000, estPeriodUnitsSold: 50, hasRealDelta: true, hasRealPrice: true },
    distinct_creators: 3, affiliate_intensity: 0.4, ...o,
  };
}

/** Fake client: rankings_cache rows by key, and a product_sold_series RPC. */
function fakeClient(payloads: Record<string, any[]>, series: Record<string, [string, number, number][]>, rpcError = false) {
  return {
    from: () => ({
      select: () => ({
        eq: (_c: string, key: string) => ({
          maybeSingle: async () => ({ data: payloads[key] ? { payload: payloads[key] } : null, error: null }),
        }),
      }),
    }),
    rpc: async (_fn: string, args: { p_product_ids: string[] }) => {
      if (rpcError) return { data: null, error: { message: 'timeout' } };
      return {
        data: args.p_product_ids.filter((id) => series[id]).map((id) => ({ product_id: id, points: series[id] })),
        error: null,
      };
    },
  } as any;
}

// 40 daily snapshots: `before` units/day until 7 days ago, `after` units/day since.
const growing = (before: number, after: number): [string, number, number][] => {
  const out: [string, number, number][] = [];
  let sold = 1000;
  for (let n = 40; n >= 0; n--) { sold += n < 7 ? after : before; out.push([day(n), sold, 10]); }
  return out;
};

test('rapid-growth view: ranks measured growers, counts products with no history', async () => {
  const client = fakeClient(
    { 'products:all:30': [payloadRow('11111'), payloadRow('22222'), payloadRow('33333')] },
    { '11111': growing(10, 40), '22222': growing(10, 20) }, // 33333 has no snapshots
  );
  const v = await buildView(client, { niche: 'all', days: 7, preset: 'rapid-growth', range: 7 });
  assert.ok(v);
  assert.deepEqual(v.rows.map((r) => r.product_id), ['11111', '22222']);
  assert.equal(v.rows[0].trend?.growth, 3);
  assert.equal(v.evaluated, 2);
  assert.equal(v.unevaluated, 1);
  // attached 7d/30d columns come from sibling payloads; unranked stays null
  assert.equal(v.rows[0].windows['7'], null);
  assert.equal(v.rows[0].windows['30']?.revenue, 1000);
});

test('a preset is always drawn from the 30d payload, whatever days says', async () => {
  const client = fakeClient({ 'products:all:7': [payloadRow('1')] }, {});
  assert.equal(await buildView(client, { niche: 'all', days: 7, preset: 'new', range: 7 }), null);
});

test('unreadable trends are not evaluated and are not shown as zero growth', async () => {
  const client = fakeClient({ 'products:all:30': [payloadRow('44444')] }, { '44444': growing(10, 40) }, true);
  const v = await buildView(client, { niche: 'all', days: 7, preset: 'rapid-growth', range: 7 });
  assert.equal(v!.rows.length, 0);
  assert.equal(v!.trendFailed, 1);
});

test('plain view attaches a trend to every row without filtering', async () => {
  const client = fakeClient({ 'products:all:14': [payloadRow('44444'), payloadRow('55555')] }, { '44444': growing(10, 40) });
  const v = await buildView(client, { niche: 'all', days: 14, preset: null, range: 7 });
  assert.equal(v!.rows.length, 2);
  assert.equal(v!.rows[0].trend?.status, 'ok');
  assert.equal(v!.rows[1].trend?.status, 'no-history');
});

// ---- tier gate: no bearer token resolves to free without any network call ----
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
function mockRes() {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}

test('free callers get 403 and no rows from preset and export, even with ?limit/page', async () => {
  for (const h of [productViews, exportProducts]) {
    const res = mockRes();
    await h({ query: { preset: 'rapid-growth', limit: '100', page: '1' }, headers: {} } as any, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.upgrade, true);
    assert.equal(res.body.products, undefined);
  }
});

test('a tier query param does not unlock anything', async () => {
  const res = mockRes();
  await exportProducts({ query: { tier: 'paid', plan: 'pro' }, headers: {} } as any, res);
  assert.equal(res.statusCode, 403);
});

test('free callers get an empty trends map, not narrowed numbers', async () => {
  const res = mockRes();
  await productTrends({ query: { ids: '1729000000001', range: '30' }, headers: {} } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'free');
  assert.deepEqual(res.body.trends, {});
});

test('bad inputs are 400, not a crash', async () => {
  let res = mockRes();
  await productViews({ query: { preset: 'nope' }, headers: {} } as any, res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  await productViews({ query: { preset: 'new', range: '90' }, headers: {} } as any, res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  await productTrends({ query: { ids: 'abc', range: '30' }, headers: {} } as any, res);
  assert.equal(res.statusCode, 400);
});
