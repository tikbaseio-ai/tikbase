# Snapshot coverage probe — why products exist with a `sold_count` but zero snapshots

**Date:** 2026-07-27
**Trigger:** product `1729664009606959759` (baby-kids, `sold_count` 7058, created 2026-07-14)
has zero rows in `product_snapshots`.
**Scope:** read-only diagnostic. No code changed.

## VERDICT: systemic gap

Not an isolated anomaly, and not expected behavior. **16,557 of 43,903 products (37.71%)
have zero snapshots**, and the population is almost perfectly explained by one change:
the Phase 3 tracked-set cap introduced in `d04d890` (2026-07-08).

| Products created | Zero-snapshot |
|---|---|
| before 2026-07-08 | 2,143 / 29,030 = **7.4%** |
| on/after 2026-07-08 | 14,414 / 14,873 = **96.9%** |

The exact excluding logic is named in §2.

## 1. Coverage numbers

Method: keyset-paginated sweep of all 43,903 `products` rows with an embedded
`product_snapshots(count)` aggregate. (Note: the join is
`product_snapshots.product_id = products.product_id` — the TikTok ID string.
`products.id` is a separate UUID surrogate key, so a `s.product_id = p.id` join
matches nothing and reports 100% uncovered.)

```
TOTAL products : 43903
ZERO-SNAPSHOT  : 16557 (37.71%)
```

### By `created_at` week — a clean cliff at the cap change

```
week_of        zero   total     pct
2026-03-16        0    1242    0.0%
2026-03-23        0     504    0.0%
2026-03-30        0    3542    0.0%
2026-04-13        0    4526    0.0%
2026-04-20        0    2900    0.0%
2026-04-27        0    2061    0.0%
2026-05-04        0    1831    0.0%
2026-05-11        0    1520    0.0%
2026-05-18        0    1814    0.0%
2026-05-25        0     963    0.0%
2026-06-01        0     668    0.0%
2026-06-08        0    1758    0.0%
2026-06-15        0    1727    0.0%
2026-06-22        0    1610    0.0%
2026-07-06     2143    2364   90.7%   <-- d04d890 lands 2026-07-08
2026-07-13     8176    8486   96.3%
2026-07-20     6238    6387   97.7%
```

Every week before the change is **0.0%** uncovered. Every week after is **>90%**.

### By `niche_slug` — two distinct clusters

```
niche                    zero%  median_sold       n
toys-games               96.5%           31    1813
baby-kids                95.5%           44    1544
accessories-jewelry      91.8%           38    2498
shoes-footwear           90.8%           75    1705
food-beverage            90.7%           49    1609
mens-grooming            87.4%           48     414
fragrance                86.2%          219    1009
haircare                 85.5%          155     387
home-kitchen             84.7%          181    1721
makeup                   69.6%          702     444
supplements              68.4%          405     434
pet-products             16.2%           33    3163
health-wellness          15.9%          147    3543
womens-wear              15.3%          284    5281
mens-wear                14.0%           94    4193
gym-fitness              13.9%           49    6531
beauty-skincare          13.7%          268    3688
tech-gadgets             13.6%          305    3791
all                       0.0%          584     135
```

The split is not about the niche itself — it is **when the niche was added**. The seven
original niches were populated before the cap and carry historical snapshots. Every niche
onboarded after 2026-07-08 (toys-games, baby-kids, accessories-jewelry, shoes-footwear,
food-beverage, mens-grooming, fragrance, haircare, home-kitchen, makeup, supplements) is
84–97% uncovered, because its products enter the catalog with low `sold_count` and never
rank into the daily top 3,000.

## 2. The excluding logic

`phase3()` in `pipeline/tikbase-daily-refresh.js` is the **only** writer to
`product_snapshots` (verified: `backfill-related-videos.js:272` and `api/top-products.ts:364`
only `select`). The tracked set is built at lines **990–1006**:

```js
const limit = limitOverride ?? SNAPSHOT_TRACKED_LIMIT;   // line 984  -> 3000
const tracked = [];
for (let from = 0; tracked.length < limit; from += 1000) {
  const { data, error } = await supabase
    .from("products")
    .select("product_id")
    .gt("sold_count", 0)                                        // (A)
    .or("price_unavailable.is.null,price_unavailable.eq.false") // (B)
    .order("sold_count", { ascending: false })                  // (C) ranking
    .range(from, from + 999);
  ...
}
const trackedSet = tracked.slice(0, limit);                     // (C) hard cap
```

with, at line 55:

```js
const SNAPSHOT_TRACKED_LIMIT = Number(process.env.SNAPSHOT_TRACKED_LIMIT) || 3000;
```

`SNAPSHOT_TRACKED_LIMIT` is **not set** in `.github/workflows/daily-refresh.yml`, so
production runs at the default 3,000.

### Attribution of the 16,557 zero-snapshot products

| Path | Count | Share |
|---|---|---|
| **A.** `sold_count` is 0/null → fails `.gt("sold_count", 0)` | 4,033 | 24.4% |
| **B.** `price_unavailable = true` → fails the `.or(...)` | 2 | 0.0% |
| **C.** **Eligible, but ranked below the 3,000 cap** | **12,522** | **75.6%** |

Of the 12,522 in bucket C, **12,520 sit below the cutoff**. The eligible pool is 35,305
products; the cap admits 3,000, so the `sold_count` at rank 3,000 is **23,834**. Anything
selling less than that is structurally invisible to snapshotting — permanently, not
transiently, because the ordering is deterministic and re-evaluated identically each run.

The two exceptions above the cutoff were both created 2026-07-26, after that day's run.

**Answering the specific sub-questions:**

- *Discovery source?* Not a factor. Spot-checked products split across both paths —
  some have `product_videos` rows (Phase 1, keyword video discovery), some have none
  (Phase 2, shop search). Both phases `upsert` into `products` unconditionally.
- *Status flag?* Only `price_unavailable`, and it accounts for 2 products. Phase 3 sets it
  on a 404 at line 1076, which is correct and self-limiting.
- *Insert order vs phase order?* Not a factor. `main()` runs `phase1() → phase2() → phase3()`
  (lines 1281–1283), so products discovered this run are already visible to Phase 3's query.
- *Row limit?* **Yes — this is the cause.** `SNAPSHOT_TRACKED_LIMIT = 3000` combined with
  `.order("sold_count", desc)`.

## 3. What changed in `d04d890`

Before (`git show d04d890^:pipeline/tikbase-daily-refresh.js`), Phase 3 paged the **entire**
products table with no filter and no cap, then wrote a snapshot row for every product —
but using the **stale stored** `p.sold_count` / `p.sale_price` off the products row.

After, Phase 3 re-fetches **fresh** values from the ScrapeCreators Product Details endpoint
per product, so snapshots actually move day-over-day and the delta model can compute real
units sold. That is a genuine correctness improvement, and it costs one API call per
product — hence the cap.

So the cap is a deliberate, defensible cost bound. The gap is its **unintended
side effect**: nothing backfills the 32,305 eligible products that fall below the cutoff,
so they went from "snapshotted daily with stale values" to "never snapshotted at all."

Daily snapshot volume shows the regime change (rows per `snapshot_date`):

```
2026-03-16      262      <- catalog still small
2026-05-01    14116
2026-06-15    23595
2026-06-27    26666      <- peak: all products, stale values
2026-06-28        0      <- outage window
2026-07-07     1963
2026-07-08        0      <- d04d890 lands
2026-07-11       25
2026-07-12        3
2026-07-13     2975      <- new regime begins
2026-07-19      512      <- partial run
2026-07-20        0      <- missed run
2026-07-26     2996      <- steady state, pinned at the 3000 cap
```

## 4. The larger consequence

Zero-snapshot count understates the problem. Products created before 2026-07-08 report
`count > 0` because they hold **historical** snapshots — but most stopped receiving new
ones around 2026-07-13.

On the most recent run, **2,996 of 43,903 products (6.82%)** received a snapshot. The other
**93.2%** carry snapshot data frozen at whatever it was when the cap took effect.

This is the input to the delta/velocity model in `api/top-products.ts`. Two consequences,
both unverified here and worth a follow-up probe:

1. Products below the cutoff can never accumulate a second snapshot, so `hasRealDelta` can
   never become true for them — they are permanently on fallback estimates.
2. Products above the cutoff whose snapshots stopped in mid-July have a widening gap
   between `snapshot_date` and today, which interacts with the trusted-span check
   (`api/top-products.ts`, the delta-span multiple guard).

Also flagged, unrelated to the cap: **2026-07-20 produced zero snapshots** and 2026-07-19
only 512, so the daily job is not reliably completing.

## 5. Reproduction

Queries were run against production via the Supabase REST API with the service-role key.
Snapshot counts come from the PostgREST embed
`products?select=product_id,niche_slug,created_at,sold_count,price_unavailable,product_snapshots(count)`,
keyset-paginated on `product_id` at 200/page (OFFSET pagination blows the statement
timeout past ~10k rows once the count aggregate is attached).

The rank-3000 cutoff:

```
products?select=sold_count&sold_count=gt.0&price_unavailable=not.is.true
         &order=sold_count.desc&limit=1&offset=2999
-> {"sold_count": 23834}
```

## 6. Fix

Shipped in the same PR as this document.

`phase3()` now draws its budget in two tiers from the same eligible pool:

- **hot** (`SNAPSHOT_HOT_LIMIT`, 1500) — top by `sold_count`, re-snapshotted every run, so
  the head of every ranking keeps a fresh day-over-day delta.
- **rotation** (`SNAPSHOT_ROTATION_LIMIT`, 4500) — least-recently-snapshotted first, NULLs
  ahead of everything else, so the 16,557 never-snapshotted products drain first and the
  tail is covered on a ~7.5-day cycle.

Rotation ordering needs a cursor, so `products.last_snapshot_date` is added and backfilled
by `pipeline/last-snapshot-date.sql` — **a manual step, run before merging**. `phase3()`
advances the cursor only for products whose snapshot row actually landed; transient
failures keep their old cursor and are retried next run rather than waiting out a cycle.

Why 4,500/run: `MAX_SPAN_RATIO = 1.5` in `api/top-products.ts` rejects any delta whose
baseline→latest span falls outside `periodDays/1.5 .. periodDays*1.5`. The shortest window
is 7 days, so the accepted band there is **4.7–10.5 days**. A ~7.5-day rotation sits inside
that band for every timeframe.

### Membership is monitored, not fetched

Products served from `rankings_cache` (10,738 of them, measured 2026-07-27) are **not** a
fetch tier. The span math above is why: a member re-snapshotted once per ~7.5-day cycle is
still inside the valid band for all timeframes, so it can still earn `hasRealDelta`.
Fetching all of them daily would buy same-day freshness that only the head of the ranking
needs — and the head is already the hot tier — at roughly 5× the credits.

Instead `reportMembershipAges()` runs at end of pipeline and reports max age, p95, median,
and the count past 9 days across the served set. If any member passes **10.5 days** it
prints a loud SLA-BREACH banner naming the worst offenders. It never fails the run: aging
members self-heal, because rotation orders `last_snapshot_date ASC NULLS FIRST` and the
stalest members are exactly what the next run picks up first. The banner is the signal to
dial up — per-niche hot coverage first (the cache is ranked per niche, so a global
`sold_count` cutoff under-serves narrow niches, which is where aging concentrates), then
`SNAPSHOT_ROTATION_LIMIT`.

The membership set comes from a `rankings_cache_members` view, revoked from
`anon`/`authenticated` and granted only to `service_role` — an anon-readable list of every
ranked `product_id` would give away the free tier's 10-row cap.

### Birth snapshots

Phase 2 (shop search) now writes a first snapshot for each genuinely-new product from the
`sold_count`/price already in its discovery payload — zero API cost — so a new product has a
delta baseline from day one instead of waiting for rotation to reach it. New ids are
identified before the upsert; the insert uses `ON CONFLICT DO NOTHING` on
`(product_id, snapshot_date)`, and Phase 3 later in the same run overwrites any seed with a
fresh-fetched value.

**Phase 1 (keyword video discovery) is deliberately excluded.** Its products come from video
anchors, which carry no `sold_count` at all. Seeding a null-`sold_count` row would be worse
than nothing: `api/top-products.ts` coerces a null baseline to 0 and would read the
product's entire lifetime volume as one period's delta. Phase 1 products instead get their
first snapshot from the next run's rotation, which picks them up immediately — they enter
with a NULL cursor and rotation is NULLS FIRST.

### Dead products

`computeTopProducts` now excludes `price_unavailable` rows, so products that 404ed upstream
stop being ranked and fall out of `rankings_cache` on the next nightly precompute. Measured
2026-07-27: 1,372 dead-but-selling products were rank-eligible, 45 of them already inside
the served set.

### Cost

**6,000 snapshot calls/day** (~6,900 including phases 1/2/4/5), up from 3,000. Phase 3 goes
from ~14 min to ~29 min at the measured 3.49 products/sec; workflow `timeout-minutes`
180 → 240.

### Credit-wall exit

`stats.api_402 > 0` now sets a non-zero exit code, so a credit-starved run shows red instead
of green (see §7). Safe to fail loudly because the run is resumable by construction: the
cursor only advances for snapshots that landed, and rotation is `ASC NULLS FIRST`, so
whatever a starved run missed is at the front of the queue next time. Topping up credits and
letting the next cron fire is the entire recovery procedure.

Not done, still open:

- 45 products in `rankings_cache` are `price_unavailable` and still served until the next
  precompute evicts them. Nothing evicts them sooner.

## 7. Why 2026-07-19 and 07-20 failed

Both runs reported **success** in GitHub Actions. Neither was a workflow failure — both hit
**ScrapeCreators credit exhaustion (HTTP 402)**.

| Run | Phase 3 result |
|---|---|
| 07-19 `29679870216` | `Fetched fresh: 512 \| 404: 1 \| transient errors: 2487` |
| 07-20 `29731529719` | `Fetched fresh: 0 \| 404: 0 \| transient errors: 3000` |

On 07-20 the wall hit at the very first call — Phase 1 got 402 on its opening keyword query,
and Phases 1/2/3/4 all finished with **0**. The job still exited green.

The tell is the log format: those lines have no `402 credit failures:` field, because the
402-aware counters landed in `d5f5e0b` ("make a credit wall loud instead of silent") at
2026-07-21 09:39 UTC — the day *after*. Both runs were on code that folded 402s into
`transient errors`, so an account-level outage was indistinguishable from flaky upstream
calls.

`d5f5e0b` fixed the visibility: 402s are now counted separately and the summary prints a
CREDIT WALL banner. It did **not** change the exit code — a fully credit-starved run still
reported success. This PR closes that: `stats.api_402 > 0` now exits non-zero.
