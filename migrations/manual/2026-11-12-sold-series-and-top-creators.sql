-- Two read-only RPCs for the trend / growth columns and the product-page upgrade.
--
-- Applied to production: NOT YET. Apply with
--   psql "$SUPABASE_DB_POOLER_URL" -v ON_ERROR_STOP=1 -f migrations/manual/2026-11-12-sold-series-and-top-creators.sql
-- then change this line to the applied date. Idempotent (create or replace),
-- additive, no table or column changes, so there is nothing to roll back beyond
-- dropping the two functions.
--
-- RLS: no table is created or altered. Both functions are revoked from
-- anon/authenticated and granted to service_role only, exactly like
-- product_snapshot_bounds / product_view_stats, because the API (service role)
-- is the only caller and is where the Free/Pro gate lives.

-- One row per product, the snapshot series folded into a jsonb array.
--
-- WHY jsonb and not one row per snapshot: PostgREST caps a response at 1000
-- rows. 50 products x 187 days is 9k rows and would be silently cut to the
-- first 1000 - the failure that has bitten this codebase twice. One row per
-- product cannot truncate.
--
-- WHY unnest + lateral and not `= any($1)`: inside a SQL function the array is a
-- parameter and the planner falls back to a generic plan (CLAUDE.md, measured
-- 100x on the product RPCs). The lateral seeks the (product_id, snapshot_date)
-- unique index per id.
--
-- Includes the newest row ON OR BEFORE the cutoff so the oldest interval in the
-- window has a baseline. Each point is [date, sold_count, sale_price].
create or replace function product_sold_series(
  p_product_ids text[],
  p_days        integer
)
returns table (
  product_id text,
  points     jsonb
)
language sql
stable
as $$
  select ids.pid,
         coalesce(jsonb_agg(
           jsonb_build_array(s.snapshot_date, s.sold_count, s.sale_price)
           order by s.snapshot_date), '[]'::jsonb)
  from unnest(p_product_ids) as ids(pid)
  cross join lateral (
    (select s1.snapshot_date, s1.sold_count, s1.sale_price
       from product_snapshots s1
      where s1.product_id = ids.pid
        and s1.snapshot_date >= current_date - greatest(1, least(p_days, 400))
      order by s1.snapshot_date)
    union all
    (select s2.snapshot_date, s2.sold_count, s2.sale_price
       from product_snapshots s2
      where s2.product_id = ids.pid
        and s2.snapshot_date < current_date - greatest(1, least(p_days, 400))
      order by s2.snapshot_date desc
      limit 1)
  ) s
  group by ids.pid;
$$;

-- Creators promoting one product, ranked by the views they drove.
--
-- creator_key is null on the 61 '@user' placeholder rows and on any row the
-- stamp missed; those are excluded rather than lumped into a fake "creator".
-- Bounded to one product, so it rides idx_pv_product_post_creator.
create or replace function product_top_creators(
  p_product_id text,
  p_limit      integer default 10
)
returns table (
  creator_key    text,
  author_name    text,
  videos         integer,
  views          bigint,
  commissioned   integer,
  last_posted_at timestamptz
)
language sql
stable
as $$
  select pv.creator_key,
         (array_agg(pv.author_name order by pv.view_count desc nulls last)
            filter (where pv.author_name is not null))[1],
         count(*)::int,
         coalesce(sum(pv.view_count), 0)::bigint,
         (count(*) filter (where pv.ad_label ~* 'commission'))::int,
         max(pv.post_ts)
  from product_videos pv
  where pv.product_id = p_product_id
    and pv.creator_key is not null
  group by pv.creator_key
  order by coalesce(sum(pv.view_count), 0) desc, pv.creator_key
  limit greatest(1, least(p_limit, 50));
$$;

revoke execute on function product_sold_series(text[], integer) from public;
revoke execute on function product_top_creators(text, integer)  from public;
revoke all on function product_sold_series(text[], integer) from anon, authenticated;
revoke all on function product_top_creators(text, integer)  from anon, authenticated;
grant execute on function product_sold_series(text[], integer) to service_role;
grant execute on function product_top_creators(text, integer)  to service_role;

-- Verification (read-only): a tracked product's series, and the creator rollup.
select product_id, jsonb_array_length(points) as snapshots
from product_sold_series(
  array(select product_id from products where sold_count > 0 order by sold_count desc limit 5), 30);

select * from product_top_creators(
  (select product_id from products where sold_count > 0 order by sold_count desc limit 1), 5);
