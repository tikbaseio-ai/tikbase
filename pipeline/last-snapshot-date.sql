-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- BEFORE merging the Phase 3 rotation change.
--
-- Four things, in order:
--   1-3  the rotation cursor (products.last_snapshot_date) + its index, which
--        phase3() uses to pick the least-recently-snapshotted products
--   4    the rankings_cache_members view, source for the end-of-run membership
--        age monitor
--   5    a ONE-TIME reset of the price_unavailable latch on still-selling
--        products (see the note there — contamination is proven, not suspected)
--   6    verification queries
--
-- Steps 1-4 are additive and safe: a nullable column, an index, and a view. No
-- existing row is destroyed and no existing query changes meaning. Step 5 is
-- the only one that mutates existing data, and it is self-correcting: anything
-- genuinely dead re-flags on its next fetch.
--
-- If this has NOT been applied, the pipeline still runs — phase3() detects the
-- missing column, prints a loud warning, and degrades to the old
-- top-N-by-sold_count behaviour; the monitor prints a [WARN] and skips.

-- 1. The cursor. NULL means "never snapshotted", which sorts first under
--    `nullsFirst: true`, so the ~16.5k products with no snapshot at all drain
--    before anything already covered is revisited.
alter table products
  add column if not exists last_snapshot_date date;

-- 2. Backfill from the snapshots already on record, so the first run after this
--    migration starts from real history instead of treating all 43.9k products
--    as never-snapshotted. Single pass over product_snapshots.
update products p
set last_snapshot_date = s.max_date
from (
  select product_id, max(snapshot_date) as max_date
  from product_snapshots
  group by product_id
) s
where s.product_id = p.product_id
  and p.last_snapshot_date is distinct from s.max_date;

-- 3. Index the rotation query: it filters on the eligible pool
--    (sold_count > 0, not price_unavailable) and orders by last_snapshot_date
--    with product_id as the tiebreak. Partial, so it stays small — the pool is
--    ~35.3k of 43.9k rows.
create index if not exists idx_products_snapshot_rotation
  on products (last_snapshot_date nulls first, product_id)
  where sold_count > 0 and price_unavailable is not true;

-- 4. Membership MONITOR source. Every product currently served from
--    rankings_cache, with its snapshot cursor, so the pipeline can check at end
--    of run how stale the served set has become.
--
--    These products are NOT fetched as their own tier. The rotation cycle
--    already keeps them inside valid delta spans: MAX_SPAN_RATIO=1.5 in
--    api/top-products.ts accepts a baseline->latest span of
--    periodDays/1.5 .. periodDays*1.5, so the tightest (7-day) window accepts
--    4.7-10.5 days, and a ~7.5-day rotation sits inside that band for every
--    timeframe. Fetching all ~10.7k members daily would buy same-day freshness
--    that only the head of the ranking needs — and the head is already the hot
--    tier — at roughly 5x the credits.
--
--    Covers both products:* and videos:* payloads (both carry a top-level
--    product_id). Joins to products and drops price_unavailable rows, which
--    computeTopProducts now also excludes from ranking. Note step 5 resets that
--    flag for still-selling products first, so the view reflects the corrected
--    set. Measured 2026-07-27 (pre-reset): 10,738 distinct members.
create or replace view rankings_cache_members as
select distinct p.product_id, p.last_snapshot_date
from rankings_cache rc
cross join lateral jsonb_array_elements(rc.payload) as elem
join products p
  on p.product_id = elem->>'product_id'
where p.price_unavailable is not true;

--    Lock the view down. rankings_cache holds the full 400-deep ranking per
--    niche/timeframe, and the free tier deliberately serves only the first 10
--    rows — an anon-readable view of every ranked product_id would hand that
--    cap away. Only the pipeline (service_role) needs it.
revoke all on rankings_cache_members from anon, authenticated;
grant select on rankings_cache_members to service_role;

-- 5. One-time reset of the price_unavailable latch on products that still show
--    sales. The flag is set on a SINGLE unconfirmed 404 (phase3, and
--    backfill-prices.js) and, until the phase 4 clear added alongside this
--    migration, nothing ever cleared it — so one transient 404 removed a
--    product from ranking and snapshotting permanently.
--
--    Contamination is proven, not suspected. Of 5 flagged products sampled by
--    live fetch on 2026-07-27, 4 returned 404 (genuinely gone) but
--    1730154985083670905 returned 200 with sold_count 137,916 against 134,044
--    stored — 3,872 units sold while it was excluded as dead. That sample was
--    deliberately biased toward the most-likely-alive rows, so ~20% is closer
--    to an upper bound than a central estimate; the point is that the rate is
--    not zero and the latch has no way to reopen.
--
--    Scope is the flagged AND still-selling set (1,372 rows as of 2026-07-27),
--    not all 1,946 flagged rows: the rest have sold_count 0 and are excluded
--    from ranking by that filter regardless.
--
--    Deliberately NOT scoped to a date. The obvious proxies do not date the
--    flag: 1,339 of the 1,372 have their last snapshot on exactly 2026-06-27,
--    which is the day the pipeline stopped snapshotting every product, not the
--    day they were flagged. Resetting the whole set is self-correcting — the
--    genuinely dead re-404 on their next phase 3 fetch and re-flag immediately,
--    while the live ones stay clear via the phase 4 clear-on-200. One-time cost
--    is at most 1,372 extra fetches, ~23% of one day's snapshot budget.
update products
set price_unavailable = false
where price_unavailable is true
  and sold_count > 0;

-- 6. Verify. Expect: total 43,903-ish; never_snapshotted ~16,557 before the
--    first rotation run, falling every day afterwards; oldest_cursor no more
--    than ~10 days behind once the cycle is established.
select
  count(*)                                              as total_products,
  count(*) filter (where last_snapshot_date is null)    as never_snapshotted,
  min(last_snapshot_date)                               as oldest_cursor,
  max(last_snapshot_date)                               as newest_cursor
from products
where sold_count > 0
  and price_unavailable is not true;

--    And the membership set. Expect ~10,738 rows — the population the
--    end-of-run membership monitor reports ages for.
select count(*) as cache_members from rankings_cache_members;

--    And the latch reset. Expect still_flagged to drop to ~574 (the sold_count=0
--    rows, which the ranking filter excludes anyway). The number here will climb
--    back over the next few runs as genuinely-dead products re-404 and re-flag;
--    that is the reset working, not failing.
select
  count(*) filter (where price_unavailable is true)                    as still_flagged,
  count(*) filter (where price_unavailable is true and sold_count > 0) as flagged_and_selling
from products;
