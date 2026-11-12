-- data_freshness: one row saying when the catalogue was last collected,
-- and when that collection was actually published to the pages.
--
-- NOT YET APPLIED. There is no pooler credential in this change. Apply it
-- before the next daily refresh, or the job will log a warning and the site
-- will keep saying the stamp is unrecorded.
--
--   psql "$SUPABASE_DB_POOLER_URL" -v ON_ERROR_STOP=1 \
--     -f migrations/manual/2026-11-12-data-freshness.sql
--
-- Why two timestamps. pipeline/tikbase-daily-refresh.js writes refreshed_at
-- when collection finishes without a credit wall. The pages do not read those
-- rows; they read rankings_cache, which pipeline/precompute-rankings.ts
-- rewrites afterwards. published_at is set then, copied from refreshed_at, so
-- a precompute that only re-sorts old snapshots cannot claim they are new,
-- and a collection that landed while precompute failed cannot either.
--
-- The seed is the last night a refresh was treated as successful: 2026-08-15,
-- the 06:00 UTC schedule. The workflow comment records that scheduled run as
-- cancelled during creator precompute, so the rankings then in the cache may
-- be from the 2026-08-14 finish. Correct the seed with one update if you have
-- a better timestamp — ON CONFLICT DO NOTHING will not overwrite it later.
--
--   update data_freshness
--      set refreshed_at = '...', published_at = '...'
--    where id = 'daily-refresh';

create table if not exists data_freshness (
  id            text primary key,
  refreshed_at  timestamptz not null,
  published_at  timestamptz
);

alter table data_freshness enable row level security;

revoke all on data_freshness from anon, authenticated;
grant select, insert, update on data_freshness to service_role;

insert into data_freshness (id, refreshed_at, published_at)
values ('daily-refresh', '2026-08-15T06:00:00Z', '2026-08-15T06:00:00Z')
on conflict (id) do nothing;

-- The shape the API reads. published_at is the public stamp.
select id, refreshed_at, published_at
from data_freshness
where id = 'daily-refresh';
