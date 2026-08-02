-- Transcript cache + spend ceiling for the "study the script" panel.
--
-- Applied to production on 2026-08-01 via the pooler.
--
-- WHY A TABLE AND NOT STORAGE: a transcript is text a user reads and copies, not
-- bytes a browser renders, and it is queried by video_id. Storage (the avatar /
-- thumbnail pattern) buys nothing here.
--
-- WHY PERMANENT: a video's spoken script never changes, so every row is
-- write-once. The alternative — fetching in the nightly pipeline — would cost
-- 163,311 credits for the videos we already hold, roughly 27x the entire daily
-- snapshot budget. On-click plus a permanent cache makes spend scale with what
-- users actually open.
create table if not exists video_transcripts (
  video_id      text primary key,
  webvtt        text,
  plain_text    text,
  -- 'ok'          transcript retrieved and stored
  -- 'unavailable' the vendor answered successfully and there is no transcript
  --
  -- A transient failure (402 out-of-credits, 5xx, timeout) is NEVER written
  -- here. See api/video-transcript.ts: caching those permanently would mark a
  -- video as captionless forever because of an outage, and the outage on
  -- 2026-08-01 is exactly the case that would have poisoned it.
  status        text not null check (status in ('ok', 'unavailable')),
  credits_spent integer not null default 0,
  fetched_at    timestamptz not null default now()
);

revoke all on video_transcripts from anon, authenticated;
grant select, insert, update on video_transcripts to service_role;

-- ---------------------------------------------------------------------------
-- Daily spend ceiling.
--
-- A user-triggered endpoint spends from the same pool as the nightly pipeline,
-- so a popular product can starve the refresh. Credits ran out entirely on
-- 2026-07-19/20 and AGAIN on 2026-08-01, so this is not hypothetical.
create table if not exists transcript_spend (
  spend_date date primary key,
  credits    integer not null default 0,
  updated_at timestamptz not null default now()
);

revoke all on transcript_spend from anon, authenticated;
grant select, insert, update on transcript_spend to service_role;

-- Atomically reserve one credit for today if the cap allows.
--
-- Reserve-before-spend, not record-after: two concurrent requests both reading
-- "199 of 200 used" would both proceed and overshoot. INSERT .. ON CONFLICT with
-- the cap in the WHERE clause makes the check and the increment one statement.
-- Returns true when the caller may spend.
create or replace function transcript_try_spend(p_cap integer)
returns boolean
language plpgsql
as $$
declare
  allowed boolean;
begin
  -- The `where p_cap > 0` guards the INSERT path. Without it, ON CONFLICT's
  -- WHERE only constrains the UPDATE, so the first request of each day was
  -- admitted regardless of the cap — a cap of 0 still let one call through.
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

-- Give a credit back when the call did not actually charge one — a 402, a
-- timeout, a network error. Without this a run of failures would burn the day's
-- ceiling without buying a single transcript.
create or replace function transcript_refund()
returns void
language sql
as $$
  update transcript_spend
     set credits = greatest(0, credits - 1), updated_at = now()
   where spend_date = current_date;
$$;

revoke all on function transcript_try_spend(integer) from anon, authenticated;
revoke all on function transcript_refund()          from anon, authenticated;
grant execute on function transcript_try_spend(integer) to service_role;
grant execute on function transcript_refund()          to service_role;

-- Verification.
select to_regclass('public.video_transcripts') as transcripts_table,
       to_regclass('public.transcript_spend')  as spend_table;

--   Cap of 0 must refuse; cap of 5 must allow, then the refund undoes it.
select transcript_try_spend(0) as refused_at_zero_cap;
select transcript_try_spend(5) as allowed_under_cap;
select credits as after_one_spend from transcript_spend where spend_date = current_date;
select transcript_refund();
select credits as after_refund from transcript_spend where spend_date = current_date;
