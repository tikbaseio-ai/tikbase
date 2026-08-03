-- Fix the PostgREST row cap that silently truncated the product ranking inputs.
--
-- Applied to production on 2026-08-03 via the pooler.
--
-- THE BUG (found in PR #26, measured here). computeTopProducts reads videos in
-- 200-product batches with .limit(5000). PostgREST caps a response at 1000 rows
-- regardless of the requested limit, so the ranking's view inputs were computed
-- from the 1000 highest-view rows per batch and nothing else. Measured on the
-- top-200 batch of the 'all' niche:
--
--     rows that exist for the batch     41,342
--     rows actually returned             1,000     (97.6% dropped)
--     products the read cannot see          25 of 200  -> totalViews 0
--     products with wrong numbers           47
--
--   worst offenders, totalViews as-computed -> truth:
--     1729384266159788902     44,672,547 ->  239,141,169
--     1729385693323694320     38,248,917 ->  219,631,827
--     1729385034780414637              0 ->  141,205,644   (invisible entirely)
--     1729385891375780291    261,714,288 ->  396,436,699
--
-- It skews hardest on exactly the products the page ranks first, because the
-- batch is ordered by sold_count and the biggest sellers carry the most videos.
--
-- THE FIX: aggregate in SQL, where there is no row cap, and return one row per
-- product instead of one row per video. Mirrors product_window_stats from Big
-- Build 2 — same batching contract, same reason.
--
-- SEMANTIC NOTE, deliberate: the JS windowed on a snowflake decoded from
-- video_url. This uses post_ts, the stored generated column
-- (posted_at, else the snowflake from video_id) that creator stats and
-- product_window_stats already use. Product windows and creator windows now
-- agree by construction rather than by coincidence.
create or replace function product_view_stats(
  p_days        integer,
  p_product_ids text[]
)
returns table (
  product_id        text,
  period_views      bigint,
  period_video_count integer,
  total_views       bigint,
  video_count       integer
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
  from product_videos pv
  where pv.product_id = any(p_product_ids)
  group by pv.product_id;
$$;

-- Thumbnails still need real rows, but only a handful per product — which the
-- old read could not guarantee either, since a product outside the top 1000
-- videos of its batch got none. row_number() gives each product its own top N.
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
    from product_videos pv
    where pv.product_id = any(p_product_ids)
  ) r
  where r.rn <= greatest(1, least(p_limit, 20));
$$;

revoke all on function product_view_stats(integer, text[]) from anon, authenticated;
revoke all on function product_top_videos(text[], integer)  from anon, authenticated;
grant execute on function product_view_stats(integer, text[]) to service_role;
grant execute on function product_top_videos(text[], integer)  to service_role;

-- Verification: the four products above must now report their true totals.
select product_id, total_views, video_count
from product_view_stats(7, array[
  '1729384266159788902','1729385693323694320',
  '1729385034780414637','1729385891375780291'])
order by total_views desc;
