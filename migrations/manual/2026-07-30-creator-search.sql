-- Creator search + creator profile (Big Build 1c).
--
-- Applied to production on 2026-07-30 via the pooler; recorded here so the
-- schema is reproducible. Additive and idempotent: two nullable columns, four
-- indexes, four functions. No existing row is destroyed and no existing query
-- changes meaning.
--
--   1  pg_trgm + trigram indexes      make ILIKE '%q%' index-served
--   2  creators.videos_count/         denormalised counts, so search can rank by
--      products_count                 volume without a per-row lateral
--   3  idx_product_videos_creator_product   index-only stats per creator
--   4  refresh_creator_counts()       nightly, called by precompute-creators
--   5  search_creators()              prefix-weighted search
--   6  creator_profile()              identity + 7d/30d stats + top videos
--   7  creator_products()             paginated products for one creator
--   8  verification selects
--
-- ---------------------------------------------------------------------------
-- WHY AN INDEX AT ALL — measured before adding, 2026-07-30, 110,586 creators.
--
--   substring ILIKE, match found     37.8 ms   (seq scan, LIMIT short-circuits)
--   substring ILIKE, NO match       194.1 ms   (seq scan, all 110,586 rows)
--   full ranked query + stats       496.9 ms   (seq scan + 20-way lateral)
--
-- 497 ms behind a 250 ms debounce is a visibly laggy type-ahead, and the
-- no-match case — which is every intermediate keystroke of a word that does not
-- exist — was the worst one. Hence the trigram indexes.
--
-- WHY DENORMALISED COUNTS. The stats lateral (videos, distinct products per
-- creator) measured ~58 ms for 20 low-volume creators and dominated the ranked
-- query for high-volume ones. Ranking search results by video volume is what
-- makes "sandra" return the prolific Sandra first, so the count has to be
-- available to the ORDER BY — i.e. on the row, not computed after the LIMIT.
-- These change only when the pipeline inserts videos, which is nightly.
-- ---------------------------------------------------------------------------

-- 1. Trigram search support.
create extension if not exists pg_trgm;

-- 2. Denormalised per-creator counts.
alter table creators
  add column if not exists videos_count   integer not null default 0,
  add column if not exists products_count integer not null default 0;

-- 3. Makes count(distinct product_id) per creator index-only, and serves the
--    profile page's product grouping.
create index if not exists idx_product_videos_creator_product
  on product_videos (creator_key, product_id)
  where creator_key is not null;

-- Trigram indexes on the lowered expressions the search predicate uses. The
-- predicate MUST be written against lower(col) for these to be chosen.
create index if not exists idx_creators_display_name_trgm
  on creators using gin (lower(display_name) gin_trgm_ops);

create index if not exists idx_creators_handle_trgm
  on creators using gin (lower(handle) gin_trgm_ops);

-- 4. Recompute the denormalised counts. One set-based UPDATE — doing this as
--    110k individual updates from the pipeline took 29 minutes when the
--    creator_key backfill did exactly that, so it stays in the database.
--    Called at the end of pipeline/precompute-creators.ts.
create or replace function refresh_creator_counts()
returns integer
language plpgsql
as $$
declare
  touched integer;
begin
  with agg as (
    select creator_key,
           count(*)::int                     as videos_count,
           count(distinct product_id)::int   as products_count
    from product_videos
    where creator_key is not null
    group by creator_key
  )
  update creators c
     set videos_count   = agg.videos_count,
         products_count = agg.products_count,
         updated_at     = now()
    from agg
   where agg.creator_key = c.creator_key
     and (c.videos_count is distinct from agg.videos_count
       or c.products_count is distinct from agg.products_count);
  get diagnostics touched = row_count;
  return touched;
end;
$$;

-- 5. Prefix-weighted creator search.
--
-- Ranking, in order: handle prefix (0), display-name prefix (1), substring
-- anywhere (2); ties broken by video volume, then recency. A creator whose
-- handle IS the query is what someone typing that query almost always means.
--
-- The needle is escaped for LIKE metacharacters — an unescaped '%' from user
-- input would otherwise match every creator, and '_' would match any character.
create or replace function search_creators(p_q text, p_limit integer default 20)
returns table (
  creator_key    text,
  display_name   text,
  handle         text,
  first_seen     timestamptz,
  last_seen      timestamptz,
  videos_count   integer,
  products_count integer,
  rank_bucket    integer
)
language sql
stable
as $$
  with q as (
    select replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_') as needle
  )
  select
    c.creator_key,
    c.display_name,
    c.handle,
    c.first_seen,
    c.last_seen,
    c.videos_count,
    c.products_count,
    case
      when lower(c.handle)       like q.needle || '%' escape '\' then 0
      when lower(c.display_name) like q.needle || '%' escape '\' then 1
      else 2
    end as rank_bucket
  from creators c, q
  where lower(c.display_name) like '%' || q.needle || '%' escape '\'
     or lower(c.handle)       like '%' || q.needle || '%' escape '\'
  order by
    case
      when lower(c.handle)       like q.needle || '%' escape '\' then 0
      when lower(c.display_name) like q.needle || '%' escape '\' then 1
      else 2
    end,
    c.videos_count desc,
    c.last_seen desc nulls last
  limit greatest(1, least(p_limit, 50));
$$;

-- 6. One creator's identity, windowed stats and top videos, in one round trip.
--
-- Post date matches pipeline/precompute-creators.ts exactly: posted_at when
-- present (only related_videos rows carry it), else the video-id snowflake
-- (timestamp = id >> 32 as unix seconds). Windowing on a different rule than the
-- leaderboard would make the profile disagree with the board it links from.
--
-- Affiliate intensity is the same definition too: share of the window's videos
-- whose ad_label mentions a commission.
create or replace function creator_profile(p_key text)
returns jsonb
language sql
stable
as $$
  with dated as (
    select
      pv.product_id,
      pv.video_id,
      pv.video_url,
      coalesce(pv.view_count, 0) as view_count,
      pv.ad_label,
      pv.cover_image_url,
      coalesce(
        pv.posted_at,
        case when pv.video_id ~ '^[0-9]{10,}$'
             then to_timestamp((pv.video_id::bigint >> 32))
        end
      ) as post_ts
    from product_videos pv
    where pv.creator_key = p_key
  ),
  win as (
    -- count(dated.post_ts), NOT count(*): this is a LEFT JOIN, so a window with
    -- no videos still yields one row with all-NULL columns, and count(*) would
    -- report 1 video for an empty window. post_ts is non-null for every matched
    -- row (the join requires it), so counting it counts real videos only.
    select
      d.days,
      count(dated.post_ts)::int                         as videos,
      count(distinct dated.product_id)::int             as products,
      coalesce(sum(dated.view_count), 0)::bigint        as views,
      count(*) filter (where dated.ad_label ~* 'commission')::int as commissioned
    from (values (7), (30)) as d(days)
    left join dated
      on dated.post_ts is not null
     and dated.post_ts >= now() - make_interval(days => d.days)
     and dated.post_ts <= now()
    group by d.days
  ),
  vids as (
    select jsonb_agg(v order by v_views desc) as videos
    from (
      select jsonb_build_object(
               'video_id', dated.video_id,
               'video_url', dated.video_url,
               'view_count', dated.view_count,
               'cover_image_url', dated.cover_image_url,
               'posted_at', dated.post_ts,
               'product_id', dated.product_id
             ) as v,
             dated.view_count as v_views
      from dated
      order by dated.view_count desc
      limit 10
    ) t
  )
  select jsonb_build_object(
    'creator', (
      select jsonb_build_object(
        'creator_key', c.creator_key,
        'display_name', c.display_name,
        'handle', c.handle,
        'author_id', c.author_id,
        'first_seen', c.first_seen,
        'last_seen', c.last_seen,
        'videos_count', c.videos_count,
        'products_count', c.products_count
      )
      from creators c where c.creator_key = p_key
    ),
    'windows', (
      select jsonb_object_agg(
        win.days::text,
        jsonb_build_object(
          'videos', win.videos,
          'products', win.products,
          'views', win.views,
          -- Guard the divide: a window with no videos has no intensity, not 0/0.
          'affiliateIntensity',
            case when win.videos > 0
                 then round(win.commissioned::numeric / win.videos, 3)
                 else null end
        )
      )
      from win
    ),
    'topVideos', coalesce((select videos from vids), '[]'::jsonb),
    'lifetimeViews', (select coalesce(sum(view_count), 0)::bigint from dated)
  );
$$;

-- 7. Every product this creator has videos for, with per-product video count and
--    total views. Paginated; total_count rides along so the caller can page
--    without a second query.
create or replace function creator_products(
  p_key text,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  product_id   text,
  title        text,
  niche_slug   text,
  image_url    text,
  videos       integer,
  views        bigint,
  total_count  bigint
)
language sql
stable
as $$
  with agg as (
    select
      pv.product_id,
      count(*)::int                        as videos,
      coalesce(sum(pv.view_count), 0)::bigint as views
    from product_videos pv
    where pv.creator_key = p_key
    group by pv.product_id
  )
  select
    agg.product_id,
    p.title,
    p.niche_slug,
    p.image_url,
    agg.videos,
    agg.views,
    count(*) over () as total_count
  from agg
  left join products p on p.product_id = agg.product_id
  order by agg.views desc, agg.videos desc
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

-- 7b. One creator's modelled GMV, extracted from the nightly payloads.
--
-- This MUST happen in the database. The obvious client-side version — select
-- payload from creator_rankings, find the creator in Node — transfers all 38
-- payloads (400 enriched creators each, with their top products) across the
-- wire to read two numbers, and measured 3.3 SECONDS end to end. Extracting
-- server-side moves ~100 bytes instead: 10.7ms.
--
-- Prefers the 'all' payload — the board the profile links back from — and
-- otherwise returns the largest niche figure.
create or replace function creator_gmv(p_key text, p_days integer default 30)
returns jsonb
language sql
stable
as $$
  with hit as (
    select
      split_part(cr.cache_key, ':', 2) as niche,
      e
    from creator_rankings cr
    cross join lateral jsonb_array_elements(cr.payload) e
    where cr.cache_key like 'creators:%:' || p_days::text
      and e->>'creator_key' = p_key
  )
  select jsonb_build_object(
           'attributedGmv',  coalesce((e->'metrics'->>'attributedGmv')::numeric, 0),
           'gmvConfidence',  coalesce((e->'metrics'->>'gmvConfidence')::numeric, 0),
           'niche',          niche,
           'days',           p_days
         )
  from hit
  order by (niche = 'all') desc,
           (e->'metrics'->>'attributedGmv')::numeric desc
  limit 1;
$$;

-- These read the full creator universe. Only the server (service_role) may call
-- them — same reasoning as the revoke on creator_rankings: the API tiers the
-- response, so raw access would hand a free caller the Pro dataset.
revoke all on function search_creators(text, integer)          from anon, authenticated;
revoke all on function creator_profile(text)                   from anon, authenticated;
revoke all on function creator_products(text, integer, integer) from anon, authenticated;
revoke all on function creator_gmv(text, integer)              from anon, authenticated;
revoke all on function refresh_creator_counts()                from anon, authenticated;
grant execute on function search_creators(text, integer)           to service_role;
grant execute on function creator_profile(text)                    to service_role;
grant execute on function creator_products(text, integer, integer) to service_role;
grant execute on function creator_gmv(text, integer)               to service_role;
grant execute on function refresh_creator_counts()                 to service_role;

-- 8. Populate the counts once, now.
select refresh_creator_counts() as rows_updated;

-- Verification.
--   Expect ~110,586 creators, all with a count; the top rows should be the same
--   prolific creators the leaderboard shows.
select count(*) as creators, count(*) filter (where videos_count > 0) as with_videos
from creators;

select creator_key, display_name, handle, videos_count, products_count
from creators order by videos_count desc limit 5;

--   Relevance spot-check.
select creator_key, display_name, handle, videos_count, rank_bucket
from search_creators('sandra', 5);
