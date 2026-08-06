-- Batched RPCs: replace `product_id = any($1)` with a join against unnest($1).
--
-- Applied to production on 2026-08-06 via the pooler.
--
-- THE PROBLEM. Every batched RPC added since Big Build 2 filters with
-- `product_id = any(p_product_ids)`. Inside a function the array is a PARAMETER,
-- so the planner cannot see its contents, cannot estimate how many rows match,
-- and settles for a generic plan. The same aggregate written inline — where the
-- planner CAN see the array — runs in 4.8ms:
--
--   inline query, 150 ids                        4.8 ms
--   product_view_stats(7, <150 ids>)           628-1748 ms
--
-- Joining against unnest() gives the planner an ordinary join with real
-- cardinality instead of an opaque array predicate. Measured on the same 150-id
-- fragrance sample:
--
--   product_view_stats   = any -> 627.9 ms     unnest join -> 6.7 ms   (94x)
--
-- WHY IT MATTERS. product_view_stats is called once per 150-product chunk, so
-- the 'all' niche (≈45k products) costs 300 calls per combo. At ~1.7s that is
-- ~8.5 minutes per combo, which matches the 2026-08-04 production run exactly
-- (all:7 at 10:28:38 -> all:14 at 10:37:27, 529s apart). Precompute took 8,238s
-- and the whole job 3h58m34s against a 240-minute timeout — 1.4 minutes of
-- headroom.
--
-- Note the pre-existing product_window_stats has the same defect; it was fast
-- enough to pass as the "bar" earlier, and it gets the same treatment here.

-- ---------------------------------------------------------------------------
create or replace function product_view_stats(
  p_days        integer,
  p_product_ids text[]
)
returns table (
  product_id         text,
  period_views       bigint,
  period_video_count integer,
  total_views        bigint,
  video_count        integer
)
language sql
stable
as $$
  select
    pv.product_id,
    coalesce(sum(pv.view_count) filter (
      where pv.post_ts >= now() - make_interval(days => p_days)
        and pv.post_ts <= now()), 0)::bigint,
    count(*) filter (
      where pv.post_ts >= now() - make_interval(days => p_days)
        and pv.post_ts <= now())::int,
    coalesce(sum(pv.view_count), 0)::bigint,
    count(*)::int
  from unnest(p_product_ids) as t(pid)
  join product_videos pv on pv.product_id = t.pid
  group by pv.product_id;
$$;

-- ---------------------------------------------------------------------------
create or replace function product_top_videos(
  p_product_ids text[],
  p_limit       integer default 5
)
returns table (
  product_id      text,
  video_url       text,
  view_count      integer,
  cover_image_url text
)
language sql
stable
as $$
  select r.product_id, r.video_url, r.view_count, r.cover_image_url
  from (
    select pv.product_id, pv.video_url, pv.view_count, pv.cover_image_url,
           row_number() over (
             partition by pv.product_id
             order by pv.view_count desc nulls last, pv.video_id
           ) as rn
    from unnest(p_product_ids) as t(pid)
    join product_videos pv on pv.product_id = t.pid
  ) r
  where r.rn <= greatest(1, least(p_limit, 20));
$$;

-- ---------------------------------------------------------------------------
-- Baselines additionally move from a cross join + DISTINCT ON to a LATERAL with
-- ORDER BY ... LIMIT 1, so each (product, window) pair is one backward walk of
-- the unique (product_id, snapshot_date) index rather than a sort over the
-- product's whole history repeated per window.
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
  with ids as (select distinct pid from unnest(p_product_ids) as t(pid)),
  latest as (
    select b.* from ids
    cross join lateral (
      select s.product_id, s.snapshot_date, s.sold_count, s.sale_price
      from product_snapshots s
      where s.product_id = ids.pid
      order by s.snapshot_date desc
      limit 1
    ) b
  ),
  earliest as (
    select b.* from ids
    cross join lateral (
      select s.product_id, s.snapshot_date, s.sold_count, s.sale_price
      from product_snapshots s
      where s.product_id = ids.pid
      order by s.snapshot_date asc
      limit 1
    ) b
  ),
  baselines as (
    select b.* from ids
    cross join unnest(p_days) as d(day)
    cross join lateral (
      select s.product_id, s.snapshot_date, s.sold_count, s.sale_price
      from product_snapshots s
      where s.product_id = ids.pid
        and s.snapshot_date <= (current_date - d.day)
      order by s.snapshot_date desc
      limit 1
    ) b
  )
  select * from latest
  union
  select * from earliest
  union
  select * from baselines;
$$;

-- ---------------------------------------------------------------------------
create or replace function product_window_stats(
  p_days        integer,
  p_product_ids text[]
)
returns table (
  product_id          text,
  distinct_creators   integer,
  window_videos       integer,
  commissioned_videos integer
)
language sql
stable
as $$
  select
    pv.product_id,
    count(distinct pv.creator_key) filter (where pv.creator_key is not null)::int,
    count(*)::int,
    count(*) filter (where pv.ad_label ~* 'commission')::int
  from unnest(p_product_ids) as t(pid)
  join product_videos pv on pv.product_id = t.pid
  where pv.post_ts >= now() - make_interval(days => p_days)
    and pv.post_ts <= now()
  group by pv.product_id;
$$;

-- The experiment function from the investigation; not part of the API.
drop function if exists product_view_stats_v2(integer, text[]);

revoke all on function product_view_stats(integer, text[])          from anon, authenticated;
revoke all on function product_top_videos(text[], integer)          from anon, authenticated;
revoke all on function product_snapshot_bounds(text[], integer[])   from anon, authenticated;
revoke all on function product_window_stats(integer, text[])        from anon, authenticated;
grant execute on function product_view_stats(integer, text[])        to service_role;
grant execute on function product_top_videos(text[], integer)        to service_role;
grant execute on function product_snapshot_bounds(text[], integer[]) to service_role;
grant execute on function product_window_stats(integer, text[])      to service_role;
