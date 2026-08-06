-- Two strikes before price_unavailable.
--
-- Applied to production on 2026-08-06.
--
-- price_unavailable is a hard latch: a flagged product leaves ranking AND
-- snapshotting, and until 2026-07-28 nothing cleared it. It was set on a
-- SINGLE 404. probes/SNAPSHOT-COVERAGE.md §8 sampled five flagged products
-- live and found one alive — a transient 404 had removed it permanently.
--
-- The counter has to be durable, and the existing tracker cannot be: the fail
-- tracker at pipeline/price-fail-tracker.json is gitignored and the pipeline
-- runs on a fresh actions/checkout every night, so its counts are born empty
-- and die with the runner. A file-backed strike therefore never reaches two,
-- and price_unavailable would simply stop being set — every dead product
-- re-fetched forever at one credit each. A column survives the runner.
alter table products
  add column if not exists price_404_strikes smallint not null default 0;

-- Products already flagged are treated as having served their strikes, so the
-- new rule does not silently un-flag the existing latch set.
update products set price_404_strikes = 2
where price_unavailable is true and price_404_strikes = 0;

select
  count(*) filter (where price_unavailable is true)      as flagged,
  count(*) filter (where price_404_strikes = 1)          as one_strike,
  count(*) filter (where price_404_strikes >= 2)         as two_plus
from products;
