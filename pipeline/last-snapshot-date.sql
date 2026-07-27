-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- BEFORE merging the Phase 3 rotation change.
--
-- Adds the rotation cursor that pipeline/tikbase-daily-refresh.js phase3() uses
-- to pick the least-recently-snapshotted products. Additive and safe: it creates
-- one nullable column plus an index, and backfills the column from data that
-- already exists in product_snapshots. No existing row is destroyed and no
-- existing query changes meaning.
--
-- If this has NOT been applied, the pipeline still runs — phase3() detects the
-- missing column, prints a loud warning, and degrades to the old
-- top-N-by-sold_count behaviour for that run.

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

-- 4. Verify. Expect: total 43,903-ish; never_snapshotted ~16,557 before the
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
