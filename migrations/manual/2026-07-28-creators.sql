-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- BEFORE merging the creator identity + aggregation change.
--
-- Creates the creator identity layer that pipeline/precompute-creators.ts reads,
-- and the cache table it writes:
--   1  creators                    canonical creator rows
--   2  product_videos.creator_key  + backfill + index
--   3  creators backfill           from the keyed video rows
--   4  creator_rankings            cache table, mirrors rankings_cache
--   5  verification selects
--
-- Additive and safe: one new column on product_videos (nullable), two new
-- tables, one index. No existing row is destroyed and no existing query changes
-- meaning. If this has NOT been applied, precompute-creators.ts detects the
-- missing table and exits cleanly without touching anything.
--
-- ---------------------------------------------------------------------------
-- KEY DERIVATION — why it is what it is (audit, 2026-07-28, 196,105 rows)
--
-- video_url carries the only stable identity signal. Two shapes exist:
--     handle    99,027 rows (50.50%)   .../@someuser/video/<id>
--     numeric   97,017 rows (49.47%)   .../@7153432386608251946/video/<id>
--     unparse.       61 rows ( 0.03%)
-- and they do NOT map cleanly onto discovery_source:
--     keyword          115,247 rows — 79.7% handle, 20.2% numeric
--     related_videos    73,724 rows — 100%  numeric
--     discover_videos    7,134 rows — 100%  handle
--
-- author_name is NOT usable as a key. It is 100% populated, but 593 display
-- names (4,56% of all rows) cover more than one distinct handle — "Ashley"
-- spans 15 handles, "Sam" 9. Keying on it would merge unrelated creators, and
-- a wrong merge is not recoverable from the aggregate.
--
-- So: creator_key = lower(handle) when the URL carries a handle, else
-- 'id:<author_id>'. 99.97% of rows key. Cardinality ~74,838.
--
-- KNOWN LIMITATION — identity SPLIT, accepted for v1.
-- 8,839 display names (13.67%) appear under exactly one handle AND at least one
-- numeric id; 77,374 rows (39.46%) sit under such a name. 1,624 of those names
-- also share at least one product_id with their numeric twin, which is strong
-- evidence of the same human. Those creators will appear TWICE in the
-- leaderboard, splitting their GMV.
--
-- This is deliberate. Splitting is recoverable — a later merge pass can fold
-- 'id:<n>' into a handle key and the aggregates simply recompute. A wrong merge
-- is not recoverable: it fabricates a creator that never existed and silently
-- overstates their GMV. v1 therefore never fuzzy-merges. Sample high-confidence
-- pairs are recorded in the PR description for a future 1c merge pass.
-- ---------------------------------------------------------------------------

-- 1. Canonical creator rows.
create table if not exists creators (
  creator_key   text primary key,        -- lower(handle), or 'id:<author_id>'
  display_name  text,                    -- newest author_name seen (nickname, may collide)
  avatar_url    text,                    -- newest author_avatar_url seen
  handle        text,                    -- set when the key came from a handle URL
  author_id     text,                    -- set when the key came from a numeric URL
  first_seen    timestamptz,
  last_seen     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 2. The foreign key on the video rows, derived from video_url.
alter table product_videos
  add column if not exists creator_key text;

-- Backfill. 'user' is the phase-1 placeholder for a missing unique_id and is
-- NOT an identity — it must stay NULL rather than collapsing every such video
-- into one fake creator.
update product_videos
set creator_key = case
      when substring(video_url from 'tiktok\.com/@([^/?#]+)/video/') is null then null
      when substring(video_url from 'tiktok\.com/@([^/?#]+)/video/') = 'user' then null
      when substring(video_url from 'tiktok\.com/@([^/?#]+)/video/') ~ '^[0-9]{6,}$'
        then 'id:' || substring(video_url from 'tiktok\.com/@([^/?#]+)/video/')
      else lower(substring(video_url from 'tiktok\.com/@([^/?#]+)/video/'))
    end
where creator_key is null;

-- The leaderboard reads videos by creator, and the aggregation reads them by
-- creator within a post-date window.
create index if not exists idx_product_videos_creator_key
  on product_videos (creator_key)
  where creator_key is not null;

-- 3. Backfill creators from the keyed video rows.
--
-- Post date: posted_at is only populated on related_videos rows (73,724 of
-- 196,105 = 37.6%). For the rest, derive it from the video id snowflake —
-- timestamp = (id >> 32) as unix seconds. Validated 2026-07-28 against the
-- 73,724 rows that carry BOTH: on a 1,000-row unbiased sample, 87.5% agree
-- within 60s, 98.8% within a day, and 97.9% land on the same UTC date. Good
-- enough for day-granularity windowing, which is all this is used for.
with keyed as (
  select
    pv.creator_key,
    pv.author_name,
    pv.author_avatar_url,
    coalesce(
      pv.posted_at,
      case when pv.video_id ~ '^[0-9]{10,}$'
           then to_timestamp((pv.video_id::bigint >> 32))
      end
    ) as post_ts,
    row_number() over (
      partition by pv.creator_key
      order by coalesce(
        pv.posted_at,
        case when pv.video_id ~ '^[0-9]{10,}$'
             then to_timestamp((pv.video_id::bigint >> 32)) end
      ) desc nulls last
    ) as rn
  from product_videos pv
  where pv.creator_key is not null
)
insert into creators (creator_key, display_name, avatar_url, handle, author_id, first_seen, last_seen)
select
  k.creator_key,
  max(k.author_name)      filter (where k.rn = 1) as display_name,
  max(k.author_avatar_url) filter (where k.rn = 1) as avatar_url,
  case when k.creator_key like 'id:%' then null else k.creator_key end as handle,
  case when k.creator_key like 'id:%' then substring(k.creator_key from 4) end as author_id,
  min(k.post_ts) as first_seen,
  max(k.post_ts) as last_seen
from keyed k
group by k.creator_key
on conflict (creator_key) do update set
  display_name = excluded.display_name,
  avatar_url   = excluded.avatar_url,
  first_seen   = least(creators.first_seen, excluded.first_seen),
  last_seen    = greatest(creators.last_seen, excluded.last_seen),
  updated_at   = now();

-- 4. Cache table for the nightly aggregates. Mirrors rankings_cache exactly so
--    1b's read path is the same shape as /api/top-products.
create table if not exists creator_rankings (
  cache_key     text primary key,          -- e.g. "creators:all:30"
  payload       jsonb not null,            -- ranked array of enriched creators
  creator_count integer not null default 0,
  computed_at   timestamptz not null default now()
);

-- Same reasoning as rankings_cache_members: the payload is the full ranked
-- leaderboard, and the product tiers it. Only the pipeline needs raw access.
revoke all on creator_rankings from anon, authenticated;
grant select on creator_rankings to service_role;

-- 5. Verification. Expected values as measured on 2026-07-28.
--    keyed_pct should be ~99.97; distinct_creators ~74,838.
select
  count(*)                                                as video_rows,
  count(creator_key)                                      as keyed_rows,
  round(100.0 * count(creator_key) / nullif(count(*), 0), 2) as keyed_pct,
  count(distinct creator_key)                             as distinct_creators
from product_videos;

--    Should equal distinct_creators above.
select count(*) as creators_rows from creators;

--    Split-vs-handle mix. Expect roughly half of keys to be 'id:' shaped —
--    that is the numeric-URL population, not an error.
select
  count(*) filter (where handle    is not null) as handle_keys,
  count(*) filter (where author_id is not null) as numeric_keys
from creators;

--    Top 10 by video volume — sanity only. These should look like real shop
--    affiliates (handle present, plausible display name, many products).
select
  c.creator_key,
  c.display_name,
  count(*)                        as videos,
  count(distinct pv.product_id)   as products,
  sum(pv.view_count)              as lifetime_views_on_their_videos
from product_videos pv
join creators c on c.creator_key = pv.creator_key
group by c.creator_key, c.display_name
order by videos desc
limit 10;
