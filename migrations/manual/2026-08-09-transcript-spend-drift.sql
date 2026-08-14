-- transcript_spend: tolerate drift from failed refunds, without ever handing
-- back a credit that was actually spent.
--
-- Applied to production on 2026-08-09.
--
-- transcript_spend.credits is a reservation counter: incremented before the
-- vendor call, decremented by transcript_refund when the call turns out not to
-- have charged. Nothing else decrements it, so a refund that fails leaves a
-- phantom credit on the day's ledger for good. The endpoint logged those
-- failures at warn level and carried on, which meant the daily cap could drain
-- without buying a single transcript and nothing would say why.
--
-- The retry in api/video-transcript.ts removes most of the failures. This
-- removes the consequence of the ones that still get through.
--
-- WHAT WAS TRIED FIRST, AND WHY IT IS NOT THIS. The obvious reconciliation is
-- to recompute the day's real spend — sum(credits_spent) over today's
-- video_transcripts rows — and clamp the ledger to it. Two measured problems
-- killed it:
--
--   1. Reconciling on every admission defeats the cap outright. `truth` only
--      catches up once the vendor answers 5-7s later, so the ledger was reset
--      before each call: a cap of 3 admitted call after call after call.
--   2. Restricting it to "only when the ledger is at the cap, once a day" still
--      failed a plain boundary test — cap 2, clean day, third call admitted —
--      because that sum UNDER-counts whenever a cache write fails, which is
--      exactly the other failure this PR fixes. It would hand back credits that
--      had genuinely been spent.
--
-- So the ledger is never inferred. Failed refunds are COUNTED, and only that
-- exact number is ever returned:
--
--   refund fails twice -> transcript_note_unrefunded() records one phantom
--   next spend         -> the phantoms are subtracted, once, and cleared
--
-- The correction can only ever be as large as the number of refunds we watched
-- fail. If the note itself fails, the day stays drifted and the log says so —
-- no worse than the behaviour this replaces, and never worse than the truth.
alter table transcript_spend
  add column if not exists unrefunded integer not null default 0;

-- Record a reservation whose refund could not be delivered.
create or replace function transcript_note_unrefunded()
returns void
language sql
as $$
  insert into transcript_spend (spend_date, credits, unrefunded, updated_at)
  values (current_date, 0, 1, now())
  on conflict (spend_date) do update
    set unrefunded = transcript_spend.unrefunded + 1,
        updated_at = now();
$$;

-- Hand back exactly the credits we know were reserved and never spent, and
-- return how many that was.
create or replace function transcript_reconcile_spend()
returns integer
language plpgsql
as $$
declare
  phantom integer;
begin
  -- RETURNING sees the pre-UPDATE value of unrefunded, which is the count.
  update transcript_spend
     set credits    = greatest(0, credits - unrefunded),
         unrefunded = 0,
         updated_at = now()
   where spend_date = current_date
     and unrefunded > 0
  returning unrefunded into phantom;

  if phantom is null or phantom = 0 then return 0; end if;
  raise warning 'transcript_spend: returned % unrefunded credit(s)', phantom;
  return phantom;
end;
$$;

-- The reservation itself. Unchanged except that it clears counted phantoms
-- first: same INSERT .. ON CONFLICT with the cap in the WHERE clause, same
-- `where p_cap > 0` guard on the INSERT path (without it a cap of 0 still
-- admitted the first call of each day).
create or replace function transcript_try_spend(p_cap integer)
returns boolean
language plpgsql
as $$
declare
  allowed boolean;
begin
  -- Cheap and exact: a no-op unless a refund was recorded as failed.
  perform transcript_reconcile_spend();

  insert into transcript_spend (spend_date, credits, updated_at)
  select current_date, 1, now()
  where p_cap > 0
  on conflict (spend_date) do update
    set credits = transcript_spend.credits + 1,
        updated_at = now()
    where transcript_spend.credits < p_cap
  returning true into allowed;
  return coalesce(allowed, false);
end;
$$;

drop function if exists transcript_reconcile_spend(integer);

revoke all on function transcript_note_unrefunded() from anon, authenticated;
revoke all on function transcript_reconcile_spend() from anon, authenticated;
revoke all on function transcript_try_spend(integer) from anon, authenticated;
grant execute on function transcript_note_unrefunded() to service_role;
grant execute on function transcript_reconcile_spend() to service_role;
grant execute on function transcript_try_spend(integer) to service_role;
