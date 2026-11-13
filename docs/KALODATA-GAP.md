# TikBase vs Kalodata: gap analysis

Written 2026-11-12 against branch `claude/kalodata-gap-features`. The Kalodata
side is a logged-in tour of a US Starter account on the same day; the TikBase
side was checked in code and in the migrations. **No live database was reachable
from the authoring environment**, so stored-data claims below are quoted from the
measurements already written into the repo (migration headers, `probes/`), and
say so where it matters.

Positioning: the affiliate's Kalodata. Full lists, affiliate-specific signals,
$44.99/mo. Kalodata Starter is $59.90/mo and caps shop and creator lists at 10
rows; contacts, exports and ad analysis need Professional at $119.90/mo.

## 1. What TikBase has today

| Area | What exists | Where |
|---|---|---|
| Product rankings | 15 categories x 6 windows (7/14/30/90/180/365d), top 400 stored per combo, est. units and revenue with a measured-vs-modelled confidence dot, 7d and 30d GMV columns side by side, creators in window, affiliate-video share, views, an "Opportunity" badge (measured sales in top quartile, creators at or below median) | `api/top-products.ts`, `pipeline/precompute-rankings.ts`, `client/src/pages/products.tsx` |
| Free vs Pro | Free: All categories, 7d, top 10 products, top 5 creators, top 10 videos. Pro: everything, enforced server-side from the bearer token | `api/_lib/resolve-tier.ts`, handlers |
| Product detail | Core stats for 7d/30d, videos driving the product (paged, free sees 3), transcripts ("study the script"), brand link | `api/product-detail.ts`, `product-detail.tsx` |
| Creators | Leaderboard (top affiliates by modelled GMV), creator profile with products and videos | `api/top-creators.ts`, `creator-profile.ts` |
| Brands/shops | Brand profile and search | `api/brand-*.ts` |
| Videos | Top videos with windows and niche filter | `api/top-videos.ts` |
| Search | Product, creator, brand type-ahead | `api/*-search.ts` |
| Saved items | Bookmarks for videos and products, **browser localStorage only** (no sync, no limit) | `client/src/lib/bookmarks.tsx` |

Data actually stored (from the repo's own measurements):

- `product_snapshots (product_id, snapshot_date, sold_count, sale_price)`: one row per tracked product per day, history from 2026-03-16. Tracked set is the hot products plus a rotation tail, **not** the catalogue: `probes/SNAPSHOT-COVERAGE.md` found 37.7% of products with no snapshots at all (96.9% of those created after 2026-07-08). Snapshot budget: 1,500 hot + 4,500 rotation per day, adjustable with `DAILY_CALL_BUDGET`.
- `product_videos`: about 347k rows with views, likes, post time, `ad_label`, `creator_key`.
- `products.commission_rate`: **structurally empty** (3,008 of 47,837 non-null, zero above 0).
- No product ratings history, no shop revenue split (live/video/card), no ad spend, no follower history for creators, no demographics.

## 2. What Kalodata has that TikBase lacks

1. Product presets: Top New, High Potential Affiliate, Sales Growth Rapidly, Top Video Products.
2. Growth % and revenue-trend sparkline columns on every list; 7/30/90 day ranges.
3. Product detail: revenue chart with date range, top creators table, top videos table.
4. Follow/watchlist with plan limits, synced to the account.
5. CSV export (Pro).
6. Creator filters (gender, language, followers, engagement, demographics, MCN, contact) and creator contact details.
7. Category/market view: shop count, revenue per shop, shop concentration, revenue split by source.
8. Revenue split live / video / product card; SKU table; reviews.
9. Video and ad analysis (GPM, ad spend, ROAS, "is AI video").
10. Livestream rankings.
11. Image search; AI chat ("Ask").
12. Creator follower-change chart and per-creator revenue history.

## 3. Ranked gaps

Scores are 1-5; **priority = value x data / effort** read as a rank, not a formula.

| # | Gap | Affiliate value | Effort | Data availability | Verdict |
|---|---|---|---|---|---|
| 1 | Growth % + sparkline trend columns, 7/30/90d | 5 | 2 | 4: `product_snapshots` for tracked products only; honest em dash elsewhere | **Built** |
| 2 | Opportunity presets (High Potential Affiliate, Rapid Growth, New) | 5 | 2 | 4: built on #1 + stored creator counts and affiliate share | **Built** |
| 3 | Product page: top creators + sales chart with range | 4 | 3 | 4: `product_videos` and snapshots | **Built** |
| 4 | CSV export | 4 | 1 | 5: the same rows the table shows | **Built** |
| 5 | Watchlist synced to account | 3 | 3 | 5, but needs a new table + auth'd write path; local bookmarks already cover the basic need | Deferred |
| 6 | Revenue split live/video/card | 3 | 5 | 1: nothing we store or scrape separates it; ScrapeCreators would need per-product calls | Deferred |
| 7 | Creator filters and contacts | 3 | 4 | 1: no follower, gender or contact data stored; scraping it is a per-creator call at scale | Deferred |
| 8 | Category/market view (shop count, concentration) | 3 | 3 | 3: derivable from `products.seller_*` but only over a partial catalogue | Deferred |
| 9 | Top Video Products preset | 3 | 2 | 4 | Deferred: overlaps the existing Trending toggle |
| 10 | Ad spend / ROAS / AI-video flag | 2 | 5 | 1 | Not feasible within the budget knob |
| 11 | Livestream rankings | 2 | 5 | 1 | Not feasible |
| 12 | Image search, AI chat | 2 | 5 | 2 | Out of scope: new paid services |

### Choices that shape what was built

- **"Decent commission" cannot be a filter.** The commission field is empty for the whole catalogue, so High Potential Affiliate uses the share of videos carrying TikTok's "Creator earns commission" label, described as exactly that and as a lower bound (only 53.5% of video rows have any ad label).
- **Presets draw from the stored top 400 by 30-day revenue**, because that is all the nightly job enriches. Every preset says "top 400"; none claims to cover the market.
- **Growth needs history we only have for tracked products.** A product without enough snapshots shows an em dash with the reason, and the presets report "N of 400 evaluated" instead of dropping the rest silently.
- **"New to TikBase", not "New launches".** We hold the date we first saw a product, not its TikTok launch date, and the 2026-07-08 discovery change means first-seen is partly a coverage artefact.
- **No extra vendor calls.** Everything reads `product_snapshots`, `product_videos` and `rankings_cache`. Trend coverage grows only as fast as the snapshot budget does; raising `DAILY_CALL_BUDGET`'s hot tier improves it with no code change.
- **Pro gating.** Presets, trend columns, the chart, full creators table and export are Pro. Free keeps the table and sees locks; the server returns 403 or omits the fields, never narrowed numbers.
