# TikBase

TikTok Shop research for affiliates. It finds products that are selling, the creators moving them, and the videos doing the work. The free tier sees a slice of the rankings. Pro sees the numbers.

## Stack

- React and Vite client in `client/`, routed with wouter over the URL hash
- Express in `server/` for local development, and one Vercel function per file in `api/`
- Supabase (Postgres via PostgREST) for products, snapshots, and the ranking caches
- Stripe for Pro billing
- ScrapeCreators for TikTok Shop collection

A new file in `api/` also needs a route in `server/routes.ts`, or it 404s locally.

## Environment

Copy `.env.example` to `.env` and fill in the values. The example lists names only.

The browser's Supabase URL and anon key are hardcoded in `client/src/lib/supabase.ts` and `client/src/lib/supabaseAuth.ts`. Everything else comes from the environment.

To boot the app locally you need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Billing routes also need `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

The nightly refresh needs `SCRAPECREATORS_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.

## Run locally

```bash
npm ci
npm run dev
```

Port 5000 is taken by macOS AirPlay. Use `PORT=5099 npm run dev` and open `http://localhost:5099`.

```bash
npm run check   # tsc
npm test        # node:test
npm run build
```

## How the refresh works

`.github/workflows/daily-refresh.yml` runs at 06:00 UTC.

1. `pipeline/tikbase-daily-refresh.js` probes the ScrapeCreators credit balance and exits before any data call if the key is missing, rejected, or the balance is below that run's estimate. A 401 is a bad key. A 402 whose body says "out of credits" is an empty balance. A 402 that says neither stops the run and quotes the body, because the vendor uses 402 for both.
2. The same script collects videos, shop products, snapshots, and missing prices. On a clean finish it writes `data_freshness.refreshed_at`.
3. `pipeline/discover-videos.js` searches for videos on under-covered ranked products. It probes the balance again for its own calls.
4. `pipeline/precompute-rankings.ts` rebuilds `rankings_cache`, then copies `refreshed_at` onto `data_freshness.published_at`. That published time is what the site shows as "Data as of". `pipeline/precompute-creators.ts` rebuilds the creator leaderboard. Neither precompute calls ScrapeCreators.

The historical snapshot budget is 1,500 hot products plus 4,500 from the rotation tail. To cut the day without a code change, set the GitHub repository variable `DAILY_CALL_BUDGET` (for example `3000`) or pass `daily_call_budget` when dispatching the workflow. Snapshots shrink to fit and keep the same hot-to-rotation ratio. Leaving it unset keeps the current budget. `SNAPSHOT_HOT_LIMIT` and `SNAPSHOT_ROTATION_LIMIT` still pin a tier when set.

`node pipeline/tikbase-daily-refresh.js --preflight-only` checks the balance and exits without collecting.

A stamp older than 48 hours is shown as a warning on the landing page and on every dashboard page.

## Migrations

Schema history is the dated SQL in `migrations/manual/`, applied by hand in filename order:

```bash
psql "$SUPABASE_DB_POOLER_URL" -v ON_ERROR_STOP=1 -f migrations/manual/<file>.sql
```

The header of each file records whether it has been applied. `2026-11-12-data-freshness.sql` has not. Apply it before the next refresh, or the job logs a warning and the site has no stamp to show.

## Schedules

`daily-refresh.yml` collects and rebuilds rankings. `prod-smoke.yml` probes the public endpoints hourly and on every push to `master`.

GitHub disables scheduled workflows in a public repository after 60 days without repository activity. `.github/workflows/keepalive.yml` re-enables those three workflows every Monday so the timer does not fire. If they are already disabled, enable them once in the Actions tab. A disabled workflow does not run its own keepalive.
