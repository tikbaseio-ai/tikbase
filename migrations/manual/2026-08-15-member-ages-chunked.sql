-- rankings_member_ages: the membership monitor, in pieces small enough to run.
--
-- Applied to production on 2026-08-15.
--
-- The monitor read the rankings_cache_members view in one go and died on the
-- 8s statement_timeout that `authenticator` carries, every night:
--
--   [WARN] Membership monitor unavailable: canceling statement due to statement timeout
--
-- and then the run summary printed `Member max age: 0d (>9d: 0)`, because the
-- stats it reports were still sitting at their initialisers. The one line an
-- operator scans after three dead days reported the healthiest possible number
-- precisely because the check had failed.
--
-- WHY THE VIEW CANNOT BE READ WHOLE, measured on production:
--
--   select count(*) from rankings_cache_members            11,939 ms
--   same, deduping product ids before joining products       6,660 ms
--   a plpgsql loop over the 240 keys into a temp table      10,956 ms
--   ONE cache_key expanded on its own                           10 ms
--
-- 240 keys x ~400 rows is 96,000 lateral expansions; nothing rewrites that into
-- 8 seconds, and the two "clever" formulations are no safer than the naive one.
-- A single key is 10ms. So the work is chunked by cache_key and the caller
-- loops, exactly like refresh_creator_counts in 2026-08-07 — the same cap, the
-- same shape of fix.
--
-- Row budget: the payload stores at most 400 products per key, so two keys per
-- call stays under PostgREST's 1000-row response cap with room to spare.
create or replace function rankings_member_ages(p_keys text[])
returns table (product_id text, last_snapshot_date date)
language sql
stable
as $$
  select distinct p.product_id, p.last_snapshot_date
  from rankings_cache rc
  cross join lateral jsonb_array_elements(rc.payload) as elem
  join products p on p.product_id = elem->>'product_id'
  where rc.cache_key = any (p_keys)
    and p.price_unavailable is not true;
$$;

-- `= any($1)` is the generic-plan trap from 2026-08-06 when the array is large
-- and the table is big. It is safe here and deliberately kept: the array is two
-- elements, and it filters rankings_cache on its primary key.

revoke all on function rankings_member_ages(text[]) from anon, authenticated;
grant execute on function rankings_member_ages(text[]) to service_role;

-- Verification: one chunk, and the shape the caller merges.
select count(*) as rows_for_two_keys
from rankings_member_ages(array['products:all:30', 'products:all:7']);
