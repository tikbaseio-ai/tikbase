/**
 * The public stamp is the moment the served rankings were published, and
 * "older than 48 hours" does not include the 48th hour itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessFromRow, STALE_AFTER_MS } from '../api/data-freshness';

const NOW = Date.parse('2026-11-12T12:00:00Z');

test('a missing row is stale and carries no timestamp', () => {
  const body = freshnessFromRow(null, NOW);
  assert.equal(body.refreshed_at, null);
  assert.equal(body.stale, true);
  assert.equal(body.age_hours, null);
  assert.equal(body.stale_after_hours, 48);
});

test('exactly 48 hours is still inside the window', () => {
  const published = new Date(NOW - STALE_AFTER_MS).toISOString();
  const body = freshnessFromRow({ published_at: published }, NOW);
  assert.equal(body.stale, false);
  assert.equal(body.age_hours, 48);
});

test('one millisecond past 48 hours is stale', () => {
  const published = new Date(NOW - STALE_AFTER_MS - 1).toISOString();
  const body = freshnessFromRow({ published_at: published }, NOW);
  assert.equal(body.stale, true);
});

test('a recent publish is not stale', () => {
  const published = new Date(NOW - 6 * 60 * 60 * 1000).toISOString();
  const body = freshnessFromRow({ published_at: published }, NOW);
  assert.equal(body.stale, false);
  assert.equal(body.refreshed_at, published);
  assert.equal(body.age_hours, 6);
});

test('refreshed_at does not move the public stamp ahead of the cache', () => {
  // Collector finished just now; precompute has not published. The pages are
  // still on the August rankings, and the stamp has to say so.
  const body = freshnessFromRow(
    {
      refreshed_at: new Date(NOW).toISOString(),
      published_at: '2026-08-15T06:00:00.000Z',
    },
    NOW,
  );
  assert.equal(body.refreshed_at, '2026-08-15T06:00:00.000Z');
  assert.equal(body.stale, true);
});

test('an unparseable stamp is treated as missing', () => {
  const body = freshnessFromRow({ published_at: 'not-a-date' }, NOW);
  assert.equal(body.refreshed_at, null);
  assert.equal(body.stale, true);
});
