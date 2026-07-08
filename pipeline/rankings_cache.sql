-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Creates the table that pipeline/precompute-rankings.ts writes to and that
-- /api/top-products reads from. Additive and safe — it touches no existing data.

create table if not exists rankings_cache (
  cache_key     text primary key,          -- e.g. "products:all:7"
  payload       jsonb not null,            -- ranked array of enriched products
  product_count integer not null default 0,
  computed_at   timestamptz not null default now()
);
