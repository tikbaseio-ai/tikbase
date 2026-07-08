/**
 * backfill-prices.js
 *
 * Standalone, on-demand backfill for products with null/zero sale_price.
 * NOT part of the daily cron. Pages through the FULL null-price backlog and
 * fetches each via the ScrapeCreators product-detail endpoint with bounded
 * concurrency (max 10 in flight), then writes price/sold_count/title/seller.
 *
 * Permanently-unavailable products (404) and junk (non-numeric product_id) are
 * marked `price_unavailable = true` so future runs skip them. Resumable: a
 * re-run only re-fetches products that are still null and not yet marked.
 *
 * Usage:
 *   node --env-file=.env pipeline/backfill-prices.js          # full backlog
 *   node --env-file=.env pipeline/backfill-prices.js 500      # first 500 only
 *
 * Requires: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: SCRAPECREATORS_REGION (default "US")
 *
 * Prerequisite for marking:
 *   ALTER TABLE products ADD COLUMN price_unavailable boolean DEFAULT false;
 * If the column is absent the script still backfills prices but logs would-be
 * marks instead of writing them.
 */

import { createClient } from "@supabase/supabase-js";

const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SCRAPECREATORS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const API_BASE = "https://api.scrapecreators.com";
const REGION = process.env.SCRAPECREATORS_REGION || "US";
const CONCURRENCY = 10; // bounded in-flight requests
const REQ_TIMEOUT_MS = 20000; // safety: stop one hung socket stalling the pool
const PROGRESS_EVERY = 500;

// Optional positional limit, e.g. `node pipeline/backfill-prices.js 500`
const limitArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const LIMIT = limitArg ? Number(limitArg) : Infinity;
// Pass `latest` (or BACKFILL_ORDER=desc) to process newest product_ids first.
const ORDER_DESC = process.argv.slice(2).includes("latest") || process.env.BACKFILL_ORDER === "desc";

const isNumericId = (id) => /^\d+$/.test(String(id));

async function apiFetchRaw(productId) {
  const url = `https://www.tiktok.com/shop/pdp/${productId}`;
  const path = `/v1/tiktok/product?url=${encodeURIComponent(url)}&region=${encodeURIComponent(REGION)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "x-api-key": SCRAPECREATORS_API_KEY },
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, err: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Extraction uses the CURRENT, verified Phase 4 paths (product_base.* top-level).
// Returns the fields to update, or null if no usable price was found.
function extractFields(data) {
  const price =
    data?.product_base?.price?.min_sku_price ??
    data?.data?.product_base?.price?.min_sku_price ??
    null;
  const pb = data?.product_base;
  const fields = { updated_at: new Date().toISOString() };
  let hasPrice = false;

  if (price != null && parseFloat(String(price).replace(/[^0-9.]/g, "")) > 0) {
    fields.sale_price = parseFloat(String(price).replace(/[^0-9.]/g, ""));
    hasPrice = true;
  }
  if (pb?.price?.original_price) {
    const op = parseFloat(String(pb.price.original_price).replace(/[^0-9.]/g, ""));
    if (op > 0) fields.original_price = op;
  }
  if (pb?.sold_count != null && pb.sold_count > 0) fields.sold_count = pb.sold_count;
  if (pb?.title) fields.title = pb.title;
  if (pb?.images?.[0]?.url_list?.[0]) fields.image_url = pb.images[0].url_list[0];
  if (data?.seller?.name) fields.seller_name = data.seller.name;
  if (data?.seller?.seller_id) fields.seller_id = data.seller.seller_id;

  return hasPrice ? fields : null;
}

// Bounded-concurrency pool — never Promise.all the whole list.
async function runPool(items, concurrency, worker, onProgress) {
  let next = 0, done = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
      done++;
      if (onProgress && done % PROGRESS_EVERY === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
}

async function columnExists() {
  const { error } = await supabase.from("products").select("price_unavailable").limit(1);
  return !error;
}

// Page through ALL null/zero-price products not already marked unavailable.
async function fetchBacklog(canMark, limit) {
  const ids = [];
  const PAGE = 1000;
  for (let from = 0; ids.length < limit; from += PAGE) {
    let q = supabase
      .from("products")
      .select("product_id")
      .or("sale_price.is.null,sale_price.eq.0")
      .order("product_id", { ascending: !ORDER_DESC })
      .range(from, from + PAGE - 1);
    if (canMark) q = q.or("price_unavailable.is.null,price_unavailable.eq.false");
    const { data, error } = await q;
    if (error) throw new Error("Fetch backlog: " + error.message);
    if (!data?.length) break;
    ids.push(...data.map((r) => r.product_id));
    if (data.length < PAGE) break;
  }
  return ids.slice(0, limit === Infinity ? undefined : limit);
}

async function markUnavailable(ids, canMark) {
  if (!canMark || ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const { error } = await supabase
      .from("products")
      .update({ price_unavailable: true })
      .in("product_id", chunk);
    if (error) console.error("  [ERROR] mark unavailable:", error.message);
  }
}

async function main() {
  const startedAt = Date.now();
  console.log(`backfill-prices started ${new Date().toISOString()} | region=${REGION} | concurrency=${CONCURRENCY} | limit=${LIMIT === Infinity ? "ALL" : LIMIT} | order=${ORDER_DESC ? "newest-first" : "oldest-first"}`);

  const canMark = await columnExists();
  if (!canMark) {
    console.warn(
      "  [WARN] column products.price_unavailable is MISSING — marking disabled.\n" +
      "         Run: ALTER TABLE products ADD COLUMN price_unavailable boolean DEFAULT false;\n" +
      "         (Prices are still backfilled; 404/junk are only counted as would-be marks.)"
    );
  }

  const backlog = await fetchBacklog(canMark, LIMIT);
  console.log(`  Backlog to process this run: ${backlog.length}\n`);

  const stats = { attempted: 0, priced: 0, p404: 0, error: 0, skippedJunk: 0 };
  const deadIds = []; // 404 + junk -> mark unavailable

  await runPool(
    backlog,
    CONCURRENCY,
    async (productId) => {
      stats.attempted++;

      // Junk (non-numeric) ids can never resolve — mark, don't call the API.
      if (!isNumericId(productId)) {
        stats.skippedJunk++;
        deadIds.push(productId);
        return;
      }

      const r = await apiFetchRaw(productId);

      if (r.status === 404) {
        stats.p404++;
        deadIds.push(productId);
        return;
      }
      if (r.status !== 200 || !r.json) {
        stats.error++; // transient (timeout/5xx) — leave for a future run
        return;
      }

      const fields = extractFields(r.json);
      if (!fields) {
        stats.error++; // 200 but no usable price — do not mark permanently
        return;
      }

      const { error } = await supabase
        .from("products")
        .update(fields)
        .eq("product_id", productId);
      if (error) {
        stats.error++;
        console.error(`  [ERROR] update ${productId}: ${error.message}`);
      } else {
        stats.priced++;
      }
    },
    (done, total) => {
      const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(1);
      console.log(`  ...${done}/${total} processed | priced=${stats.priced} 404=${stats.p404} err=${stats.error} junk=${stats.skippedJunk} | ${rate} req/s`);
    }
  );

  await markUnavailable(deadIds, canMark);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`  attempted:      ${stats.attempted}`);
  console.log(`  priced:         ${stats.priced}`);
  console.log(`  404:            ${stats.p404}`);
  console.log(`  error (transient): ${stats.error}`);
  console.log(`  skipped-junk:   ${stats.skippedJunk}`);
  console.log(`  marked unavailable (404+junk): ${canMark ? deadIds.length : `0 (would mark ${deadIds.length} — column missing)`}`);
  console.log(`  wall-clock:     ${secs}s  (${(stats.attempted / secs).toFixed(1)} req/s)`);
  console.log(`backfill-prices done ${new Date().toISOString()}`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
