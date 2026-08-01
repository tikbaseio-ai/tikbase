-- Product search + the miss-capture queue (product search / detail build).
--
-- Applied to production on 2026-07-31 via the pooler; recorded here so the
-- schema is reproducible. Additive: two indexes, one table, one function.
--
-- WHY AN INDEX — measured before adding, 2026-07-31, 48,706 products:
--
--     'serum'                  3.3 ms   (common term, LIMIT short-circuits)
--     'leave in conditioner' 193.0 ms   (rare term, full scan)
--     'zzqqxx'               182.6 ms   (no match, full scan)
--
-- Same shape and same verdict as the creator search: the no-match case is every
-- intermediate keystroke of a word that does not exist yet, and 193ms behind a
-- 250ms debounce is a visibly laggy type-ahead.

create extension if not exists pg_trgm;

-- Predicates MUST be written against lower(col) for these to be chosen.
create index if not exists idx_products_title_trgm
  on products using gin (lower(title) gin_trgm_ops);

create index if not exists idx_products_seller_trgm
  on products using gin (lower(seller_name) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Miss capture.
--
-- A search that returns nothing is the single most useful signal this product
-- collects: it is a user telling us, unprompted, which product they expected us
-- to cover. The reviewer's own example ("Based Leave In Conditioner") returns
-- zero today — the catalogue has two "leave in conditioner" products and
-- neither is that one — so this queue starts earning immediately.
--
-- `kind` exists because the table is named for searches generally: creator
-- search will want the same queue, and a generic table with no discriminator
-- would silently merge two different demand signals.
create table if not exists search_misses (
  id          bigserial primary key,
  kind        text        not null default 'product',
  query       text        not null,
  user_tier   text,
  searched_at timestamptz not null default now()
);

-- Reading the queue is "what did people want, recently" and "how often was this
-- asked for".
create index if not exists idx_search_misses_searched_at
  on search_misses (searched_at desc);
create index if not exists idx_search_misses_query
  on search_misses (kind, lower(query));

-- Server-only, like every other analytical table here: it records user input and
-- nothing client-side should read or write it directly.
revoke all on search_misses from anon, authenticated;
grant select, insert on search_misses to service_role;
grant usage, select on sequence search_misses_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Prefix-weighted product search.
--
-- Ranking: title prefix (0) > seller prefix (1) > substring anywhere (2).
-- Within a bucket, a product that is actually ranked in the last 30 days
-- outranks one that is not, by its modelled revenue; everything else falls back
-- to lifetime units sold.
--
-- NOTE: this first definition unnests the 30-day payloads inline. It is
-- superseded at the bottom of this file — that approach measured 260ms on a
-- no-match query and the reasoning is recorded there. Kept in place so the file
-- reads as what was actually run, in order, against production.
--
-- The needle is escaped for LIKE metacharacters — an unescaped '%' from user
-- input would otherwise match the entire catalogue.
create or replace function search_products(p_q text, p_limit integer default 20)
returns table (
  product_id       text,
  title            text,
  seller_name      text,
  image_url        text,
  sale_price       numeric,
  sold_count       integer,
  niche_slug       text,
  est_revenue_30d  numeric,
  has_ranking_data boolean,
  rank_bucket      integer
)
language sql
stable
as $$
  with q as (
    select replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_') as needle
  ),
  rev as (
    select
      e->>'product_id' as product_id,
      max((e->'metrics'->>'estRevenue')::numeric) as est_revenue_30d
    from rankings_cache cr
    cross join lateral jsonb_array_elements(cr.payload) e
    where cr.cache_key like 'products:%:30'
    group by e->>'product_id'
  )
  select
    p.product_id,
    p.title,
    p.seller_name,
    p.image_url,
    p.sale_price,
    p.sold_count,
    p.niche_slug,
    rev.est_revenue_30d,
    rev.product_id is not null as has_ranking_data,
    case
      when lower(p.title)       like q.needle || '%' escape '\' then 0
      when lower(p.seller_name) like q.needle || '%' escape '\' then 1
      else 2
    end as rank_bucket
  from products p
  cross join q
  left join rev on rev.product_id = p.product_id
  where lower(p.title)       like '%' || q.needle || '%' escape '\'
     or lower(p.seller_name) like '%' || q.needle || '%' escape '\'
  order by
    case
      when lower(p.title)       like q.needle || '%' escape '\' then 0
      when lower(p.seller_name) like q.needle || '%' escape '\' then 1
      else 2
    end,
    rev.est_revenue_30d desc nulls last,
    p.sold_count desc nulls last
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function search_products(text, integer) from anon, authenticated;
grant execute on function search_products(text, integer) to service_role;

-- Verification.
select count(*) as products, count(seller_name) as with_seller from products;

--   The reviewer's example — expected to return 0 rows today, which is the
--   whole reason search_misses exists.
select count(*) as based_leave_in_conditioner_hits
from search_products('based leave in conditioner', 20);

--   Relevance spot-checks.
select title, seller_name, sold_count, has_ranking_data, rank_bucket
from search_products('leave in conditioner', 5);

select title, seller_name, sold_count, has_ranking_data, rank_bucket
from search_products('stanley', 5);

-- ---------------------------------------------------------------------------
-- MATERIALISED 30-DAY REVENUE — added after measuring the first version.
--
-- The tiebreak originally unnested every `products:%:30` payload inline, on
-- every keystroke: 15 payloads x up to 400 products, whether the search matched
-- two rows or none. That fixed cost dominated everything else —
--
--     'zzqqxx' (no match)            260 ms
--     'leave in conditioner'         271 ms
--     'serum' (cold)                1754 ms
--
-- — which is exactly the laggy type-ahead the trigram indexes were added to
-- avoid. The payloads only change when the nightly precompute rewrites them, so
-- the lookup belongs in a table, not in the request.
create table if not exists product_revenue_30d (
  product_id      text primary key,
  est_revenue     numeric not null default 0,
  has_real_delta  boolean not null default false,
  computed_at     timestamptz not null default now()
);

revoke all on product_revenue_30d from anon, authenticated;
grant select on product_revenue_30d to service_role;

-- Refreshed at the end of pipeline/precompute-rankings.ts, right after the 30d
-- payloads it reads are written. Full replace rather than upsert: a product that
-- drops out of every ranking should lose its row, not keep a stale figure.
create or replace function refresh_product_revenue_30d()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  delete from product_revenue_30d;
  insert into product_revenue_30d (product_id, est_revenue, has_real_delta)
  select
    e->>'product_id',
    max((e->'metrics'->>'estRevenue')::numeric),
    bool_or((e->'metrics'->>'hasRealDelta')::boolean)
  from rankings_cache cr
  cross join lateral jsonb_array_elements(cr.payload) e
  where cr.cache_key like 'products:%:30'
    and e->>'product_id' is not null
  group by e->>'product_id';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function refresh_product_revenue_30d() from anon, authenticated;
grant execute on function refresh_product_revenue_30d() to service_role;

-- Search now joins the table instead of the payloads.
create or replace function search_products(p_q text, p_limit integer default 20)
returns table (
  product_id       text,
  title            text,
  seller_name      text,
  image_url        text,
  sale_price       numeric,
  sold_count       integer,
  niche_slug       text,
  est_revenue_30d  numeric,
  has_ranking_data boolean,
  rank_bucket      integer
)
language sql
stable
as $$
  with q as (
    select replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_') as needle
  )
  select
    p.product_id, p.title, p.seller_name, p.image_url, p.sale_price,
    p.sold_count, p.niche_slug,
    r.est_revenue,
    r.product_id is not null as has_ranking_data,
    case
      when lower(p.title)       like q.needle || '%' escape '\' then 0
      when lower(p.seller_name) like q.needle || '%' escape '\' then 1
      else 2
    end as rank_bucket
  from products p
  cross join q
  left join product_revenue_30d r on r.product_id = p.product_id
  where lower(p.title)       like '%' || q.needle || '%' escape '\'
     or lower(p.seller_name) like '%' || q.needle || '%' escape '\'
  order by
    case
      when lower(p.title)       like q.needle || '%' escape '\' then 0
      when lower(p.seller_name) like q.needle || '%' escape '\' then 1
      else 2
    end,
    r.est_revenue desc nulls last,
    p.sold_count desc nulls last
  limit greatest(1, least(p_limit, 50));
$$;

select refresh_product_revenue_30d() as revenue_rows_loaded;
-- Product detail: the videos already working for one product.
--
-- Windowing matches precompute-creators / product_window_stats exactly (post_ts,
-- the stored generated column) so this page cannot disagree with the tables that
-- link to it.
create or replace function product_detail(p_product_id text, p_video_limit integer default 24)
returns jsonb
language sql
stable
as $$
  with v as (
    select
      pv.video_id, pv.video_url, pv.creator_key, pv.author_name,
      coalesce(pv.view_count, 0) as view_count,
      coalesce(pv.like_count, 0) as like_count,
      pv.ad_label, pv.cover_image_url, pv.post_ts
    from product_videos pv
    where pv.product_id = p_product_id
  ),
  win as (
    select d.days,
           count(v.post_ts)::int as videos,
           count(distinct v.creator_key) filter (where v.creator_key is not null)::int as creators,
           coalesce(sum(v.view_count), 0)::bigint as views,
           count(*) filter (where v.ad_label ~* 'commission')::int as commissioned
    from (values (7), (30)) as d(days)
    -- LEFT JOIN + count(v.post_ts), never count(*): an empty window would
    -- otherwise report one video for its own all-NULL row.
    left join v on v.post_ts is not null
                and v.post_ts >= now() - make_interval(days => d.days)
                and v.post_ts <= now()
    group by d.days
  )
  select jsonb_build_object(
    'product', (
      select jsonb_build_object(
        'product_id', p.product_id, 'title', p.title, 'seller_name', p.seller_name,
        'seller_tiktok_url', p.seller_tiktok_url, 'product_url', p.product_url,
        'niche_slug', p.niche_slug, 'niche_label', p.niche_label,
        'sale_price', p.sale_price, 'original_price', p.original_price,
        'sold_count', p.sold_count, 'stock_quantity', p.stock_quantity,
        'rating', p.rating, 'review_count', p.review_count, 'created_at', p.created_at)
      from products p where p.product_id = p_product_id
    ),
    'windows', (select jsonb_object_agg(win.days::text, jsonb_build_object(
        'videos', win.videos, 'creators', win.creators, 'views', win.views,
        -- null, never 0%: "no videos" and "no commissioned videos" differ.
        'affiliateIntensity', case when win.videos > 0
          then round(win.commissioned::numeric / win.videos, 3) else null end)) from win),
    'revenue30d', (select jsonb_build_object('estRevenue', r.est_revenue, 'hasRealDelta', r.has_real_delta)
                   from product_revenue_30d r where r.product_id = p_product_id),
    'totals', (select jsonb_build_object(
        'videos', count(*), 'creators', count(distinct creator_key) filter (where creator_key is not null),
        'views', coalesce(sum(view_count), 0)::bigint) from v),
    'videos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'video_id', t.video_id, 'video_url', t.video_url, 'creator_key', t.creator_key,
        'author_name', t.author_name, 'view_count', t.view_count, 'like_count', t.like_count,
        'ad_label', t.ad_label, 'posted_at', t.post_ts,
        'commissioned', t.ad_label ~* 'commission'))
      from (select * from v order by view_count desc limit greatest(1, least(p_video_limit, 60))) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function product_detail(text, integer) from anon, authenticated;
grant execute on function product_detail(text, integer) to service_role;

select product_detail('1732409732818375505', 3) is not null as smoke_ok;
