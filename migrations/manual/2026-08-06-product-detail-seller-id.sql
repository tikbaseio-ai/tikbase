-- product_detail: carry seller_id.
--
-- Applied to production on 2026-08-06. One added key; the rest of the function
-- is byte-identical to 2026-08-01-product-detail-paging.sql (verified against
-- pg_proc.prosrc before rewriting).
--
-- The product page shows the shop name, and it now links to that shop's brand
-- page. Without the id the link would have to address the brand by name and
-- pay a resolution lookup on a page that already knows the answer.

create or replace function product_detail(
  p_product_id   text,
  p_video_limit  integer default 24,
  p_video_offset integer default 0
)
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
        'seller_id', p.seller_id,
        'seller_tiktok_url', p.seller_tiktok_url, 'product_url', p.product_url,
        'niche_slug', p.niche_slug, 'niche_label', p.niche_label,
        'sale_price', p.sale_price, 'original_price', p.original_price,
        'sold_count', p.sold_count, 'stock_quantity', p.stock_quantity,
        'rating', p.rating, 'review_count', p.review_count, 'created_at', p.created_at)
      from products p where p.product_id = p_product_id
    ),
    'windows', (select jsonb_object_agg(win.days::text, jsonb_build_object(
        'videos', win.videos, 'creators', win.creators, 'views', win.views,
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
      from (
        select * from v
        order by view_count desc, video_id
        limit greatest(1, least(p_video_limit, 60))
        offset greatest(0, p_video_offset)
      ) t
    ), '[]'::jsonb)
  );
$$;
