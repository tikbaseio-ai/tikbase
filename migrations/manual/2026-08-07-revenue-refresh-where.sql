-- refresh_product_revenue_30d: give the DELETE a WHERE clause.
--
-- Applied to production on 2026-08-07.
--
-- The function has failed on every call since it shipped, and only ever as a
-- warning line the nightly log swallowed:
--
--   [WARN] refresh_product_revenue_30d failed: DELETE requires a WHERE clause
--
-- Supabase preloads `supautils` (session_preload_libraries = supautils), which
-- refuses an unqualified DELETE or UPDATE for the PostgREST role. The guard
-- fires on the statement inside the function body, so the whole refresh aborts
-- and product_revenue_30d keeps whatever it last held. `where true` satisfies
-- the guard and is the same full replace the function always intended — a
-- product that drops out of every ranking must lose its row, not keep a stale
-- figure.
--
-- Measured damage before the fix: 5,647 stored rows against 7,402 currently
-- ranked products — 5,427 ranked products had no row at all, and 1,561 of the
-- rows that did exist were off by more than 1%. The table backs the revenue
-- column in product search and the GMV figures on the brand pages, so both
-- were serving numbers from an unknown earlier date.
create or replace function refresh_product_revenue_30d()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  -- `where true`: supautils blocks an unqualified DELETE for the PostgREST
  -- role, and this function is only ever called through PostgREST (by
  -- pipeline/precompute-rankings.ts, via supabase.rpc).
  delete from product_revenue_30d where true;
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
