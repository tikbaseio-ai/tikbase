-- Tokenised fallback for product search.
--
-- Applied to production on 2026-08-03 via the pooler.
--
-- THE BUG. search_products matched the query as one substring. The top row in
-- search_misses is "Based Leave In Conditioner" — and that product has been in
-- the catalogue the whole time:
--
--   BASED Leave-in Conditioner | Instant Hydration & Anti-Frizz   242,093 sold
--
-- '%based leave in conditioner%' cannot match 'based leave-in conditioner'
-- because of the hyphen. The miss was recorded as a coverage gap and was
-- actually a matching failure — no amount of new discovery keywords would have
-- fixed it, and "based bodyworks" was already a discovery keyword.
--
-- THE FIX, without losing the fast path. The phrase match is what the trigram
-- indexes serve, so it runs first and unchanged. Only when it finds nothing does
-- the tokenised pass run: every whitespace-separated token must appear in the
-- title or the seller name, with punctuation flattened to spaces first. That
-- second pass is not index-served, but it only ever runs for queries that
-- currently return zero results, where the alternative is showing nothing.
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
language plpgsql
stable
as $$
declare
  needle text := replace(replace(replace(lower(btrim(p_q)), '\', '\\'), '%', '\%'), '_', '\_');
  hits   integer;
begin
  -- Pass 1: phrase match, trigram-indexed. Unchanged behaviour.
  return query
    select p.product_id, p.title, p.seller_name, p.image_url, p.sale_price,
           p.sold_count, p.niche_slug, r.est_revenue,
           r.product_id is not null,
           case
             when lower(p.title)       like needle || '%' escape '\' then 0
             when lower(p.seller_name) like needle || '%' escape '\' then 1
             else 2
           end
    from products p
    left join product_revenue_30d r on r.product_id = p.product_id
    where lower(p.title)       like '%' || needle || '%' escape '\'
       or lower(p.seller_name) like '%' || needle || '%' escape '\'
    order by
      case
        when lower(p.title)       like needle || '%' escape '\' then 0
        when lower(p.seller_name) like needle || '%' escape '\' then 1
        else 2
      end,
      r.est_revenue desc nulls last,
      p.sold_count desc nulls last
    limit greatest(1, least(p_limit, 50));

  -- ROW_COUNT is an integer, not a boolean.
  get diagnostics hits = row_count;
  if hits > 0 then
    return;
  end if;

  -- Pass 2: every token must appear somewhere in title + seller, with
  -- punctuation flattened so "leave-in" and "leave in" are the same thing.
  return query
    with toks as (
      select array_remove(
               string_to_array(btrim(regexp_replace(lower(btrim(p_q)), '[^a-z0-9]+', ' ', 'g')), ' '),
               ''
             ) as t
    )
    select p.product_id, p.title, p.seller_name, p.image_url, p.sale_price,
           p.sold_count, p.niche_slug, r.est_revenue,
           r.product_id is not null,
           3
    from products p
    cross join toks
    left join product_revenue_30d r on r.product_id = p.product_id
    where cardinality(toks.t) > 0
      and (
        select bool_and(
          regexp_replace(lower(p.title || ' ' || coalesce(p.seller_name, '')), '[^a-z0-9]+', ' ', 'g')
          like '%' || tok || '%'
        )
        from unnest(toks.t) tok
      )
    order by r.est_revenue desc nulls last, p.sold_count desc nulls last
    limit greatest(1, least(p_limit, 50));
end;
$$;

revoke all on function search_products(text, integer) from anon, authenticated;
grant execute on function search_products(text, integer) to service_role;

-- Verification: the reviewer's exact query must now find the product.
select left(title, 52) as title, seller_name, sold_count, rank_bucket
from search_products('Based Leave In Conditioner', 5);

-- And the fast path must be unchanged.
select left(title, 40) as title, rank_bucket from search_products('stanley', 3);
