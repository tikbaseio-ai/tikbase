-- Applied once in the Supabase SQL editor (2026-07-10) BEFORE enabling the
-- related_videos mining in pipeline/tikbase-daily-refresh.js (Phase 3).
--
-- Context: the daily snapshot job already calls ScrapeCreators Product Details
-- for every tracked product; that response carries a `related_videos` array we
-- were discarding. We now persist it into product_videos, deduped on the numeric
-- video id and physically guarded by a unique index.
--
-- NOTE: creating the unique index initially FAILED because the table already
-- held duplicate (product_id, video_id) rows (~29% of the table; some videos had
-- 40-67 copies) — a separate keyword-pipeline re-insert bug that lacks working
-- dedup. Those duplicates were collapsed (keeping the highest view_count per
-- pair) before the index could be built. Fixing that keyword re-insert bug is a
-- separate follow-up task.

-- 1. Numeric TikTok video id, backfilled from the URL. Dedup key for the mining
--    and the unique index below. (Plain column — the keyword insert paths do not
--    yet populate it, so it can be null on their rows until that bug is fixed.)
alter table product_videos add column if not exists video_id text;
update product_videos
  set video_id = substring(video_url from 'video/([0-9]+)')
  where video_id is null;

-- 2. Collapse pre-existing duplicate (product_id, video_id) rows, keeping the
--    best row per pair. Safe: the ranking already dedups by video id at read
--    time, so nothing user-facing changed.
delete from product_videos pv using (
  select id, row_number() over (
    partition by product_id, video_id
    order by view_count desc nulls last, created_at desc nulls last, id desc
  ) rn
  from product_videos where video_id is not null
) d
where pv.id = d.id and d.rn > 1;

-- 3. Physically block future (product_id, video_id) duplicates. Leading
--    product_id column also serves .in('product_id', ...) lookups, so no
--    separate product_id index is needed. Null video_ids are allowed / don't
--    conflict.
create unique index if not exists uq_product_videos_product_video
  on product_videos (product_id, video_id);

-- 4. Additive columns for the mined payload.
--    discovery_source: DEFAULT 'keyword' backfills existing rows; related rows
--    set 'related_videos'. No comment_count exists in the related_videos payload.
alter table product_videos add column if not exists discovery_source text not null default 'keyword';
alter table product_videos add column if not exists like_count bigint;
alter table product_videos add column if not exists ad_label text;
alter table product_videos add column if not exists posted_at timestamptz; -- from related_videos.upload_time (unix seconds); null for keyword rows
