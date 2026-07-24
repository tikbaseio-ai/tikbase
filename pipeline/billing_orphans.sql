-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Creates the table the Stripe webhook writes to when a paid checkout can't be
-- linked to any account (Layer C). Additive and safe — touches no existing data.
--
-- A row here means: real money came in, but the buyer has no matching Supabase
-- account, so access was NOT granted. These are the customers to chase down.
-- The reconcile-at-login safety net (Layer B) flips status → 'resolved'
-- automatically if the buyer later logs in with the same email.

create table if not exists billing_orphans (
  id                     bigint generated always as identity primary key,
  stripe_session_id      text unique,          -- checkout.session id (idempotency key)
  stripe_subscription_id text,
  stripe_customer_id     text,
  email                  text,                 -- buyer email Stripe captured
  status                 text not null default 'unresolved',  -- unresolved | resolved
  reason                 text,                 -- why it couldn't link
  resolved_user_id       uuid,                 -- set when self-healed / manually granted
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz
);

create index if not exists billing_orphans_email_idx  on billing_orphans (lower(email));
create index if not exists billing_orphans_status_idx on billing_orphans (status);

-- The one query you actually check:
--   select * from billing_orphans where status = 'unresolved' order by created_at desc;
