-- Bounded per-product snapshot read, replacing the truncated one.
--
-- Applied to production on 2026-08-03 via the pooler.
--
-- THE BUG (found in PR #31). computeTopProducts read snapshots in 200-product
-- batches with .limit(10000). PostgREST caps a response at 1000 rows, and the
-- query sorts snapshot_date ASCENDING, so what came back was the globally
-- OLDEST slice of the table:
--
--   rows that exist for the top-200 batch   17,954
--   rows returned                            1,000    (94.4% dropped)
--   date range returned            2026-03-16 .. 2026-04-17
--   newest snapshot that exists              2026-08-02
--
-- 2026-03-16 is the oldest snapshot in the entire table, which is the tell: the
-- read was returning the front of the table, not the front of each product's
-- history. calculateSnapshotDelta was therefore computing "sales in the last 7
-- days" from rows up to 3.5 months stale, and then correctly rejecting nearly
-- all of them for failing its own span sanity check (MAX_SPAN_RATIO). That is
-- the likely cause of hasRealDelta covering only 0.93% of ranked rows and of the
-- opportunity badge never firing on the 'all' payloads.
--
-- THE FIX. The estimator does not need a product's whole history — it needs a
-- specific handful of rows:
--
--   earliest              firstSeenDaysActive
--   latest                sold_count, sale_price, and the delta's upper end
--   last row <= (now - d) the delta's baseline, for each window d it tries
--                         (calculateSnapshotDelta is called for the requested
--                          window and then for [180, 90, 30, 14, 7] shorter ones)
--
-- So this returns at most 2 + |p_days| rows per product instead of its full
-- series, which is both correct and small enough that nothing truncates. The
-- reduced set preserves the JS semantics exactly: the loop there picks the LAST
-- snapshot <= cutoff, which is precisely the row selected here, and when no such
-- row exists it falls back to sorted[0] = earliest, which is also present.
create or replace function product_snapshot_bounds(
  p_product_ids text[],
  p_days        integer[]
)
returns table (
  product_id    text,
  snapshot_date date,
  sold_count    integer,
  sale_price    numeric
)
language sql
stable
as $$
  with base as (
    select s.product_id, s.snapshot_date, s.sold_count, s.sale_price
    from product_snapshots s
    where s.product_id = any(p_product_ids)
  ),
  latest as (
    select distinct on (b.product_id) b.product_id, b.snapshot_date, b.sold_count, b.sale_price
    from base b order by b.product_id, b.snapshot_date desc
  ),
  earliest as (
    select distinct on (b.product_id) b.product_id, b.snapshot_date, b.sold_count, b.sale_price
    from base b order by b.product_id, b.snapshot_date asc
  ),
  baselines as (
    -- The newest row on or before each cutoff: the baseline the delta needs.
    select distinct on (b.product_id, d.day)
           b.product_id, b.snapshot_date, b.sold_count, b.sale_price
    from base b
    cross join unnest(p_days) as d(day)
    where b.snapshot_date <= (current_date - d.day)
    order by b.product_id, d.day, b.snapshot_date desc
  )
  select * from latest
  union
  select * from earliest
  union
  select * from baselines;
$$;

revoke all on function product_snapshot_bounds(text[], integer[]) from anon, authenticated;
grant execute on function product_snapshot_bounds(text[], integer[]) to service_role;

-- Verification: the returned rows must now reach August, not stop in April.
select min(snapshot_date) as oldest_returned,
       max(snapshot_date) as newest_returned,
       count(*)           as rows_returned,
       count(distinct product_id) as products
from product_snapshot_bounds(
  array(select product_id from products
        where sold_count > 0 and price_unavailable is not true
        order by sold_count desc limit 100),
  array[7, 14, 30, 90, 180, 365]);
