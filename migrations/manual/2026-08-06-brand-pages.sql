-- Brand search + brand profile.
--
-- Applied to production on 2026-08-06 via the pooler. Additive: one index, two
-- functions. Touches nothing the nightly precompute writes.
--
-- Brands are not a table. `products` carries seller_id (47,408 of 51,963 rows)
-- and seller_name (40,655), giving 18,567 distinct sellers. A brand is therefore
-- a GROUP BY over products, and the only structure needed is an index.
--
-- All batched/filtered lookups here join or filter on a single seller_id rather
-- than `= any($array)`, so they avoid the generic-plan trap that made the
-- product RPCs 100x slow (see 2026-08-06-rpc-unnest-join.sql).

-- The brand page filters products by seller_id, and nothing indexed it: the
-- only seller index was the trigram one on lower(seller_name), which cannot
-- serve an equality lookup on the id.
create index if not exists idx_products_seller_id
  on products (seller_id)
  where seller_id is not null;

-- Short queries cannot use a trigram index: below 3 characters there are no
-- trigrams, so 'an' degenerated to a full recheck of 40,655 rows (measured
-- p50 105ms, p95 5.8s). A btree on lower(seller_name) with text_pattern_ops
-- serves the prefix form the two-character case falls back to.
create index if not exists idx_products_seller_name_prefix
  on products (lower(seller_name) text_pattern_ops)
  where seller_id is not null and seller_name is not null;

-- ---------------------------------------------------------------------------
-- Brand search: grouped seller matches.
--
-- Ranking mirrors search_products — name prefix first, then substring — with
-- ties broken by catalogue weight (total sold, then product count), so
-- "shark" surfaces the shop that actually sells Sharks rather than the first
-- alphabetical match.
create or replace function search_brands(p_q text, p_limit integer default 20)
returns table (
  seller_id     text,
  seller_name   text,
  product_count integer,
  total_sold    bigint,
  niches        integer,
  rank_bucket   integer
)
language sql
stable
as $$
  with q as (
    select replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_') as needle
  ),
  matched as (
    select
      p.seller_id,
      -- Sellers occasionally differ in casing/whitespace across rows; take the
      -- most common spelling rather than an arbitrary one.
      mode() within group (order by p.seller_name) as seller_name,
      count(*)::int                                as product_count,
      coalesce(sum(p.sold_count), 0)::bigint       as total_sold,
      count(distinct p.niche_slug)::int            as niches,
      min(case when lower(p.seller_name) like (select needle from q) || '%' escape '\'
               then 0 else 1 end)                  as bucket
    from products p
    cross join q
    where p.seller_id is not null
      and p.seller_name is not null
      and lower(p.seller_name) like '%' || q.needle || '%' escape '\'
    group by p.seller_id
  )
  select seller_id, seller_name, product_count, total_sold, niches, bucket
  from matched
  order by bucket, total_sold desc, product_count desc
  limit greatest(1, least(p_limit, 50));
$$;

-- Short-needle variant: prefix match only.
--
-- A separate function rather than a length branch inside search_brands. Both
-- forms in one body gives the planner one plan for two access paths, and it
-- picked the trigram index for both — leaving the 2-character case exactly as
-- slow as before (measured: 3.8s). Split, each gets the index it needs:
-- 'an' goes from p50 105ms / p95 5.8s to p50 1.2ms / p95 2.5ms.
--
-- Prefix-only is also the right semantics at this length: a two-letter
-- substring matches a third of the catalogue and ranks nothing usefully.
create or replace function search_brands_prefix(p_q text, p_limit integer default 20)
returns table (
  seller_id     text,
  seller_name   text,
  product_count integer,
  total_sold    bigint,
  niches        integer,
  rank_bucket   integer
)
language sql
stable
as $$
  with q as (
    select replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_') as needle
  ),
  matched as (
    select
      p.seller_id,
      mode() within group (order by p.seller_name) as seller_name,
      count(*)::int                          as product_count,
      coalesce(sum(p.sold_count), 0)::bigint as total_sold,
      count(distinct p.niche_slug)::int      as niches
    from products p
    cross join q
    where p.seller_id is not null
      and p.seller_name is not null
      and lower(p.seller_name) like q.needle || '%' escape '\'
    group by p.seller_id
  )
  -- Every row is a prefix hit, so the bucket is uniformly 0.
  select seller_id, seller_name, product_count, total_sold, niches, 0
  from matched
  order by total_sold desc, product_count desc
  limit greatest(1, least(p_limit, 50));
$$;

-- ---------------------------------------------------------------------------
-- Brand header: the aggregate the page leads with.
create or replace function brand_profile(p_seller_id text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'seller_id',     p_seller_id,
    'seller_name',   mode() within group (order by p.seller_name),
    'product_count', count(*)::int,
    'total_sold',    coalesce(sum(p.sold_count), 0)::bigint,
    'niches',        (
      select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
      from (select distinct p2.niche_slug as x
            from products p2
            where p2.seller_id = p_seller_id and p2.niche_slug is not null) t
    ),
    'seller_tiktok_url', max(p.seller_tiktok_url),
    'first_seen',    min(p.created_at),
    -- Brand-level 30-day GMV, the paid header stat. An inner join, so
    -- 'products' counts only what is modelled: the page can then say "5 of 34
    -- products modelled" instead of implying the whole catalogue is covered.
    'revenue_30d', (
      select jsonb_build_object(
        'est_revenue', coalesce(sum(r.est_revenue), 0)::numeric,
        'products',    count(*)::int,
        'measured',    count(*) filter (where r.has_real_delta)::int
      )
      from products p3
      join product_revenue_30d r on r.product_id = p3.product_id
      where p3.seller_id = p_seller_id
    )
  )
  from products p
  where p.seller_id = p_seller_id
  -- A seller_id with no rows must yield NULL, not an object full of zeros, so
  -- the API can answer 404 rather than render a blank brand.
  having count(*) > 0;
$$;

-- ---------------------------------------------------------------------------
-- Brand products, paginated, ordered by 30-day GMV.
--
-- Revenue comes from product_revenue_30d, the materialised lookup the nightly
-- precompute fills — this only READS it, and never touches rankings_cache.
-- NULLS LAST so unranked products sort below ranked ones instead of above.
create or replace function brand_products(
  p_seller_id text,
  p_limit     integer default 25,
  p_offset    integer default 0
)
returns table (
  product_id     text,
  title          text,
  niche_slug     text,
  sale_price     numeric,
  sold_count     integer,
  stock_quantity integer,
  est_revenue_30d numeric,
  has_real_delta boolean,
  total_count    bigint
)
language sql
stable
as $$
  select
    p.product_id, p.title, p.niche_slug, p.sale_price, p.sold_count,
    p.stock_quantity, r.est_revenue, r.has_real_delta,
    count(*) over () as total_count
  from products p
  left join product_revenue_30d r on r.product_id = p.product_id
  where p.seller_id = p_seller_id
  order by r.est_revenue desc nulls last, p.sold_count desc nulls last
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

revoke all on function search_brands(text, integer)              from anon, authenticated;
revoke all on function search_brands_prefix(text, integer)       from anon, authenticated;
revoke all on function brand_profile(text)                       from anon, authenticated;
revoke all on function brand_products(text, integer, integer)    from anon, authenticated;
grant execute on function search_brands(text, integer)           to service_role;
grant execute on function search_brands_prefix(text, integer)    to service_role;
grant execute on function brand_profile(text)                    to service_role;
grant execute on function brand_products(text, integer, integer) to service_role;

-- Verification.
select count(*) as distinct_brands from (select distinct seller_id from products where seller_id is not null) t;

--   Relevance: the brand should be the obvious one.
select seller_name, product_count, total_sold, rank_bucket from search_brands('shark', 3);
select seller_name, product_count, total_sold, rank_bucket from search_brands('medicube', 3);
select seller_name, product_count, total_sold, rank_bucket from search_brands('based', 3);
select seller_name, product_count, total_sold from search_brands_prefix('an', 3);

--   A brand page's two reads.
select brand_profile((select seller_id from products where seller_name = 'BASED' limit 1)) is not null as profile_ok;
select count(*) as brand_product_rows
from brand_products((select seller_id from products where seller_name = 'BASED' limit 1), 25, 0);

-- ---------------------------------------------------------------------------
-- Name -> id resolution.
--
-- The products leaderboard is served from rankings_cache payloads, which carry
-- seller_name but not seller_id, and those payloads are written by the nightly
-- precompute — not something a brand link should force a rebuild of. So the
-- row link addresses the brand by name and resolves here.
--
-- A name is not unique (the same shop appears under several seller_ids after a
-- rename or a region split), so pick the id with the biggest catalogue rather
-- than an arbitrary one: that is the shop a user clicking the name means.
create or replace function brand_id_for_name(p_name text)
returns text
language sql
stable
as $$
  select p.seller_id
  from products p
  where p.seller_id is not null
    and lower(p.seller_name) = lower(btrim(p_name))
  group by p.seller_id
  order by count(*) desc, coalesce(sum(p.sold_count), 0) desc
  limit 1;
$$;

revoke all on function brand_id_for_name(text) from anon, authenticated;
grant execute on function brand_id_for_name(text) to service_role;

select brand_id_for_name('BASED') is not null as name_resolves;
