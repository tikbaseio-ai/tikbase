-- Per-product, per-window creator metrics for the Top Products overhaul
-- (Big Build 2).
--
-- Applied to production on 2026-07-30 via the pooler; recorded here so the
-- schema is reproducible. Additive: one function, one index. Nothing existing
-- changes meaning.
--
-- WHY A FUNCTION AND NOT 45,000 QUERIES. precompute-rankings enriches every
-- product in every niche x window combo (15 x 6 = 90 combos over ~47k products).
-- Asking per product would be ~4M round trips. This aggregates the whole table
-- once per WINDOW — six calls for a full run — and the pipeline memoises the
-- result per window, so the niche loop reuses it.
--
-- WHY affiliate intensity AND NOT commission rate. products.commission_rate is
-- a confirmed vendor gap (probe fb8c4ed): of 47,837 products, 3,008 carry a
-- non-null commission_rate and ZERO carry one greater than zero. The column is
-- structurally present and semantically empty, so the shippable signal is the
-- one the video rows actually carry — the share of a window's videos labelled
-- "Creator earns commission".
--
-- HONEST LIMIT of that signal: ad_label is populated on 185,770 of 346,954 video
-- rows (53.5%). A missing label is not evidence that a video is unpaid, so
-- affiliate_intensity is a LOWER BOUND on how commissioned a product's promotion
-- is. It is null — never 0 — when a window has no videos at all, because "no
-- videos" and "no commissioned videos" are different claims.

-- Post date, materialised.
--
-- The windowing rule must match pipeline/precompute-creators.ts exactly:
-- posted_at when present (only related_videos rows carry it), else the video-id
-- snowflake (timestamp = id >> 32 as unix seconds). A product windowed on a
-- different rule than the creator leaderboard would disagree with it on screen.
--
-- It is a STORED GENERATED COLUMN rather than an expression in the query
-- because computing it per row made the aggregate a full 346k-row scan taking
-- ~9.5s — which is fine over a direct connection and FATAL through PostgREST,
-- whose statement timeout cancelled it at ~8s. The pipeline talks to PostgREST,
-- so the version that worked in psql would never have run in production.
-- Materialised + indexed, the aggregate touches only the window's rows.
alter table product_videos
  add column if not exists post_ts timestamptz
  generated always as (
    coalesce(
      posted_at,
      case when video_id ~ '^[0-9]{10,}$'
           then to_timestamp((video_id::bigint >> 32))
      end
    )
  ) stored;

create index if not exists idx_product_videos_post_ts
  on product_videos (post_ts)
  where post_ts is not null;

-- Takes an explicit product batch so every call is bounded.
--
-- THE CONSTRAINT, measured. Aggregating a whole window in one call does not
-- work through the Supabase REST gateway, which cuts requests off at ~10s with
-- "upstream request timeout" — that is the HTTP layer, so a function-scoped
-- statement_timeout does not help (tried; still 500s). Whole-window costs:
--
--     7d      0.76s        30d    11.49s
--    14d      1.33s        90d    79.59s
--
-- so everything from 30d up is unservable in one shot. Bucketing on
-- hashtext(product_id) did not help either: the filter reduces the rows GROUPED
-- but not the rows SCANNED, so each bucket still paid for the whole window.
--
-- Passing the product ids makes the scan itself bounded — it rides
-- idx_pv_product_post_creator, ordered by product_id, so the aggregate streams
-- without a sort. The caller chunks and merges.
--
-- Bucketing on PRODUCT rather than on time is also what keeps the numbers
-- correct: count(distinct creator_key) cannot be merged across time slices,
-- because a creator who posted in two slices would be counted twice. Each
-- product appears in exactly one chunk, so its aggregate is complete.
drop function if exists product_window_stats(integer);
drop function if exists product_window_stats(integer, integer, integer);

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
    -- creator_key is stamped at every write path now, but the 61 '@user'
    -- placeholder rows stay null and must not count as a creator.
    count(distinct pv.creator_key) filter (where pv.creator_key is not null)::int,
    count(*)::int,
    count(*) filter (where pv.ad_label ~* 'commission')::int
  from product_videos pv
  where pv.product_id = any(p_product_ids)
    and pv.post_ts >= now() - make_interval(days => p_days)
    and pv.post_ts <= now()
  group by pv.product_id;
$$;

-- Serves the batched aggregate: leading product_id bounds the scan to the
-- batch, and the index order lets the group-by stream without a sort.
create index if not exists idx_pv_product_post_creator
  on product_videos (product_id, post_ts, creator_key)
  where post_ts is not null;

revoke all on function product_window_stats(integer, text[]) from anon, authenticated;
grant execute on function product_window_stats(integer, text[]) to service_role;

-- Verification: the commission-rate gap this replaces, and a window sample.
select
  count(*)                                          as products,
  count(commission_rate)                            as with_commission_rate,
  count(*) filter (where commission_rate > 0)       as commission_rate_gt_zero
from products;

select count(*) as products_with_30d_videos
from product_window_stats(30, array(select product_id from products));

select * from product_window_stats(30, array(select product_id from products limit 2000))
order by distinct_creators desc limit 5;
