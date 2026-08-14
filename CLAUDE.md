# TikBase

TikTok Shop analytics. Find products that are selling, the creators moving them,
and the videos doing the work. Free tier sees a slice; Pro sees the numbers.

## Layout

| path | what lives there |
|---|---|
| `api/*.ts` | Vercel serverless functions — one file, one endpoint, default-exported handler |
| `server/routes.ts` | Express dev-server mirror. **Every new `api/` handler needs a route here or it 404s in dev** |
| `client/src/pages/` | one file per route; `client/src/components/` for shared UI |
| `shared/` | code both sides import (`resolve-tier.ts`, `creator-key.js`, `avatar-cache.ts`) |
| `pipeline/` | nightly cron work — discovery, snapshots, precompute. Runs under bare `node` |
| `migrations/manual/` | dated `.sql`, applied by hand. The only schema history there is |
| `probes/` | written-up investigations. Read before re-deriving something |

Routing is wouter over the hash. `'/dashboard/*'`, not `'/dashboard/:rest*'` —
the named-param form matches a single trailing segment.

## Design system

- **Accent: violet `#a855f7`, and it lives in exactly one place** —
  `--primary` in `client/src/index.css`. Never write a colour literal in a
  component; there is no `text-[#...]` anywhere and the next rebrand should
  stay a three-line change. Use `text-primary` / `bg-primary/10` /
  `border-primary/30`, and `text-primary-bright` for small text sitting on a
  primary tint (the accent at 65% lightness is 4.42:1 on its own 10% tint,
  under the 4.5:1 floor; `--primary-bright` is the same hue at 72%).
- `--primary-foreground` is near-black, measured: on the violet fill it reads
  5.00:1 against white's 3.96:1.
- **Type: IBM Plex Sans**, `IBM Plex Mono` for anything numeric. Every metric,
  id, price, date and count is monospaced — columns of numbers must line up.
- **No emojis.** Not in the UI, not in copy, not in commit messages.
- Dark surface, `border-border` hairlines, `rounded-lg` cards, tabular density.
  Match the page you are editing rather than introducing a new spacing scale.
- The scale, after BB3: page shell `p-5 md:p-8`, table cells `py-3.5 px-4`
  (headers `py-3`), cards `px-5 py-4`, section gap `mb-8`, grid gap `gap-4`.
  Product thumbs are 56px in tables, avatars 44px in the leaderboard and 80-96px
  on a profile.
- Below `md`, the products and creators tables render as cards instead — a
  twelve-column metrics table cannot be shrunk into 390px. The desktop tables
  are `hidden md:block`; the card lists are `md:hidden`.

## Numbers must not lie

- An absent figure is an em dash `—`, **never `$0` or `0%`**. `$0` asserts the
  thing sold nothing; a dash says we have no figure. Different claims.
- Paid-only fields are **omitted from the response** for free callers, not
  zeroed or truncated. Tier comes from the bearer token via
  `shared/resolve-tier.ts` — never from a query param.
- Enforce limits server-side. `?limit=100&page=3` must not widen a free slice.
- Say what a number covers when the coverage is partial ("20 of 77 products
  modelled"), rather than presenting a subtotal as a total.

## Data and infrastructure

- Supabase (PostgREST + pooler). **PostgREST caps every response at 1000 rows**
  regardless of `.limit()` — page, or do the work in SQL. This has caused two
  separate silent data bugs; assume it will cause a third.
- `= any($1)` inside a SQL function is a parameter, so the planner cannot
  estimate cardinality and falls back to a generic plan. Join against
  `unnest()` instead. (100x on the product RPCs.)
- The REST gateway cuts requests at ~10s. A function-scoped `statement_timeout`
  does not help.
- Trigram indexes match nothing below 3 characters — a short needle needs a
  `text_pattern_ops` btree and a prefix query.
- **Migrations are self-served.** Apply them yourself over
  `SUPABASE_DB_POOLER_URL` (in `.env`), then commit the dated file to
  `migrations/manual/` with the applied date in its header. Do not leave a
  migration for someone else to run.
- ScrapeCreators costs 1 credit per call. `use_ai_as_fallback` costs 10 and is
  never sent.

## Estimation changes are invisible until the nightly precompute

Everything on the products and creators pages is served from `rankings_cache`
and `creator_rankings`, written by `pipeline/precompute-*.ts`. Editing
`api/top-products.ts` changes **nothing** a user sees until that precompute runs
again.

So: after an estimation change, trigger the precompute and verify against the
rebuilt payloads. "The code is right" is not a verification. A recompute over
all combos takes hours — start it early, and do not sit blocked on it.

## Verify before you ask for a merge

- `npm run check` (tsc) and `npm test` (node:test, `pipeline/*.test.js`).
- `npm run build`, and boot `npm run dev` and load a page. Port 5000 is taken by
  macOS AirPlay — use `PORT=5099`.
- Curl the endpoint as **both** a free and a paid token. A tier claim without
  two responses next to it is not evidence.
- Check 390px. The app is used on phones; nothing may scroll sideways.
- Screenshots and scratch scripts go in the **scratchpad**, never in the repo.

Report what you measured, not what you expect. If a number surprises you,
measure the server side before blaming it — a laptop's WAN round trip to
Supabase is ~90ms and has already produced one false alarm.

## Working here

- `gh` is at `~/bin/gh`, not on `PATH`. PRs go to `tikbaseio-ai/tikbase`
  against `master`.
- **One task per session.** Open the PR and stop; do not merge, and do not pick
  up the next thing because it looks adjacent.
- Never approve a PR.
- If another session is mid-recompute, treat `pipeline/precompute-*.ts`,
  `api/top-products.ts`, `rankings_cache` and `creator_rankings` as off limits.
- Comments earn their place by explaining *why* — the constraint, the measured
  number, the bug that made the code look like this. Not what the line does.
