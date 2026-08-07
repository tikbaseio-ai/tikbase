-- refresh_creator_counts: chunk it, because 8 seconds is the hard ceiling.
--
-- Applied to production on 2026-08-07.
--
-- The function has failed every night since 2026-07-31, as a warning line the
-- log swallowed:
--
--   [WARN] refresh_creator_counts failed: canceling statement due to statement timeout
--
-- It feeds creators.videos_count / products_count, which are the ORDER BY of
-- search_creators (so creator search ranked by week-old volume), the "N videos"
-- line under every creator hit in both search boxes, and "videos all time" on
-- the creator profile. Measured drift when this was written: 30,895 of 110,586
-- creators — 28% — carried a wrong count, and creators.updated_at had not moved
-- since 2026-07-31.
--
-- WHY IT TIMED OUT, measured.
--
--   aggregate over all 567,052 keyed rows, visibility map stale   14,292 ms
--   the same aggregate after VACUUM (Heap Fetches 93,457 -> 0)       681 ms
--
-- The plan was never wrong — it is an index-only scan on
-- idx_product_videos_creator_product either way. It was doing 93k random heap
-- reads because the visibility map was stale, and the nightly call lands
-- immediately after the pipeline's insert wave, which is exactly when it is
-- stalest. So "vacuum and it is fast" is not a fix; it is the cold path that
-- has to fit.
--
-- WHY NOT RAISE THE TIMEOUT. PostgREST connects as `authenticator`, whose
-- rolconfig carries statement_timeout=8s, and that is the cap on every RPC.
-- A `set local statement_timeout` inside the function does NOT lift it:
-- statement_timeout is armed when the outer statement starts, and the function
-- body runs inside that statement. Probed directly on this database:
--
--   pg_sleep(10), no set local          -> canceled at 8.8s
--   pg_sleep(12), set local '120s'      -> canceled at 8.2s
--   pg_sleep(20), set local '120s'      -> canceled at 8.2s
--   pg_sleep(45), set local '120s'      -> canceled at 8.2s
--
-- So the work has to fit in 8s. It is chunked by creator_key range instead:
-- each call does a bounded slice and returns a cursor, and the caller loops.
--
-- Chunk size is 2,000 keys, and it was measured down to that, not reasoned to.
-- Worst case for a chunk is every row in it changing, so each size was timed
-- after zeroing that range's counts to force 100% churn:
--
--   20,000 keys   worst chunk of a live sweep   8.81s   at the ceiling
--    5,000 keys   100% churn, 4,749 rows        6.48s   still too close
--    2,000 keys   100% churn, 1,894 rows        1.10s   7x margin
--
-- The cost is superlinear in the key range because the aggregate is only half
-- of it — the UPDATE and its WAL are the other half, and the low end of the
-- keyspace holds the creators with the most videos. 163,737 keys at 2,000 per
-- chunk is ~82 calls, about 90s in total, inside a creator precompute that
-- already runs for 41 minutes.
--
-- The old zero-argument signature is dropped: leaving it in place would let a
-- caller keep invoking the version that cannot finish.
drop function if exists refresh_creator_counts();

create or replace function refresh_creator_counts(
  p_after text    default null,
  p_limit integer default 2000
)
returns jsonb
language plpgsql
as $$
declare
  hi      text;
  touched integer;
  lim     integer := greatest(1, least(coalesce(p_limit, 2000), 50000));
begin
  -- Upper bound of this chunk: the lim-th distinct creator_key after the
  -- cursor. The index is (creator_key, product_id), so this is an ordered
  -- index-only scan that stops as soon as it has lim groups.
  select max(k) into hi
  from (
    select distinct creator_key as k
    from product_videos
    where creator_key is not null
      and (p_after is null or creator_key > p_after)
    order by 1
    limit lim
  ) t;

  -- No keys left after the cursor: the sweep is complete.
  if hi is null then
    return jsonb_build_object('done', true, 'touched', 0, 'last_key', p_after);
  end if;

  with agg as (
    select creator_key,
           count(*)::int                   as videos_count,
           count(distinct product_id)::int as products_count
    from product_videos
    where creator_key is not null
      and (p_after is null or creator_key > p_after)
      and creator_key <= hi
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

  -- `done` is false while a cursor remains; the caller stops when it flips.
  return jsonb_build_object('done', false, 'touched', touched, 'last_key', hi);
end;
$$;

revoke all on function refresh_creator_counts(text, integer) from anon, authenticated;
grant execute on function refresh_creator_counts(text, integer) to service_role;
