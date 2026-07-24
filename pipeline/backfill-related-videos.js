/**
 * backfill-related-videos.js
 *
 * Standalone, on-demand, ONE-TIME backfill. NOT part of the daily cron.
 *
 * The daily Phase 3 job mines related_videos only for the products it snapshots
 * (top SNAPSHOT_TRACKED_LIMIT by sold_count). That leaves the trusted products
 * ranked below that cutoff — which sell (real day-over-day sold_count deltas) but
 * have NO attached videos — permanently untouched. This script closes exactly
 * that gap: it fetches ScrapeCreators Product Details ONCE for the
 * trusted-but-untracked zero-video products and mines each response's
 * related_videos into product_videos, through the same upsert path as Phase 3.
 *
 * Target set = { trusted (>=14d snapshot history + >=1 positive 30-day delta) }
 *              ∩ { zero attached videos } ∩ { NOT in the daily top-N tracked set }.
 * (~2.3k products / ~2.3k credits as of 2026-07). Run it AFTER a full daily cron
 * pass so it doesn't re-do products the cron already covers.
 *
 * Idempotent + resumable: the unique index (product_id, video_id) + video-id
 * dedup mean a re-run inserts nothing new and only refreshes counts upward; any
 * product that gained videos since the last run drops out of the target set.
 *
 * Usage:
 *   node --env-file=.env pipeline/backfill-related-videos.js          # full gap
 *   node --env-file=.env pipeline/backfill-related-videos.js 200      # first 200 (testing)
 *
 * Requires: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: SCRAPECREATORS_REGION (default "US"), SNAPSHOT_TRACKED_LIMIT (default 3000)
 *
 * NOTE: the related_videos mapping + upsert below is MIRRORED from
 * pipeline/tikbase-daily-refresh.js (upsertRelatedVideos and its helpers). If
 * that logic changes there, update it here too.
 */

import { createClient } from "@supabase/supabase-js";

const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SCRAPECREATORS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const API_BASE = "https://api.scrapecreators.com";
const REGION = process.env.SCRAPECREATORS_REGION || "US";
const CONCURRENCY = 10;
const REQ_TIMEOUT_MS = 20000;
const PAGE = 1000;
const TRACKED_LIMIT = Number(process.env.SNAPSHOT_TRACKED_LIMIT) || 3000; // must match the cron
const WINDOW_DAYS = 30, MIN_HISTORY_DAYS = 14, SNAPSHOT_LOOKBACK_DAYS = 45;

const limitArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const LIMIT = limitArg ? Number(limitArg) : Infinity;

// ---------------------------------------------------------------------------
// Raw Product Details fetch (does not throw on non-2xx). Mirrors Phase 3.
// ---------------------------------------------------------------------------
async function fetchProductDetailRaw(productId) {
  const url = `https://www.tiktok.com/shop/pdp/${productId}`;
  const path = `/v1/tiktok/product?url=${encodeURIComponent(url)}&region=${encodeURIComponent(REGION)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { "x-api-key": SCRAPECREATORS_API_KEY }, signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, err: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Bounded-concurrency pool — never Promise.all the whole list.
async function runPool(items, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
}

// ---------------------------------------------------------------------------
// related_videos helpers — MIRRORED from tikbase-daily-refresh.js
// ---------------------------------------------------------------------------
function extractVideoId(url) {
  const m = String(url || "").match(/video\/(\d+)/);
  return m ? m[1] : null;
}
const toIntOrNull = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
function uploadTimeToISO(v) {
  const s = Number(String(v ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(s) || s <= 0) return null;
  const d = new Date(s * 1000);
  const y = d.getUTCFullYear();
  if (y < 2015 || y > 2035) return null;
  return d.toISOString();
}

// MIRRORED from tikbase-daily-refresh.js upsertRelatedVideos. Dedup keyed on
// numeric video_id; insert new (discovery_source='related_videos'), update
// existing view/like counts only when higher; 23505 hits are benign skips.
async function upsertRelatedVideos(relatedByProduct) {
  const s = { products: relatedByProduct.size, candidates: 0, inserted: 0, updated: 0, skipped: 0, constraintSkipped: 0 };
  if (relatedByProduct.size === 0) return s;

  const byProduct = new Map();
  for (const [productId, entries] of relatedByProduct) {
    const m = new Map();
    for (const e of entries || []) {
      const videoId = e?.item_id ? String(e.item_id) : extractVideoId(e?.url);
      if (!videoId) continue;
      const url = e?.url || `https://www.tiktok.com/@${e?.author_id || "user"}/video/${videoId}`;
      const cand = {
        product_id: String(productId),
        video_id: videoId,
        video_url: url,
        view_count: toIntOrNull(e?.play_count),
        like_count: toIntOrNull(e?.like_count),
        author_name: e?.author_name || null,
        author_avatar_url: e?.author_avatar_url || null,
        cover_image_url: e?.cover_image_url || null,
        ad_label: e?.bc_ad_label_text || null,
        posted_at: uploadTimeToISO(e?.upload_time),
        discovery_source: "related_videos",
      };
      const prev = m.get(videoId);
      if (!prev || (cand.view_count || 0) > (prev.view_count || 0)) m.set(videoId, cand);
    }
    if (m.size) { byProduct.set(String(productId), m); s.candidates += m.size; }
  }
  if (byProduct.size === 0) return s;

  // Existing rows for these products, PAGINATED (no 1000-row cap), keyed by video id.
  const productIds = [...byProduct.keys()];
  const existing = new Map();
  for (let i = 0; i < productIds.length; i += 100) {
    const chunk = productIds.slice(i, i + 100);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("product_videos")
        .select("id, product_id, video_id, video_url, view_count, like_count")
        .in("product_id", chunk)
        .range(from, from + PAGE - 1);
      if (error) throw new Error("fetch existing: " + error.message);
      if (!data?.length) break;
      for (const row of data) {
        const vid = row.video_id || extractVideoId(row.video_url);
        if (!vid) continue;
        if (!existing.has(row.product_id)) existing.set(row.product_id, new Map());
        existing.get(row.product_id).set(vid, row);
      }
      if (data.length < PAGE) break;
    }
  }

  const inserts = [];
  const updates = [];
  for (const [productId, m] of byProduct) {
    const ex = existing.get(productId) || new Map();
    for (const [videoId, cand] of m) {
      const prior = ex.get(videoId);
      if (!prior) { inserts.push(cand); continue; }
      const fields = {};
      if (cand.view_count != null && cand.view_count > (prior.view_count || 0)) fields.view_count = cand.view_count;
      if (cand.like_count != null && cand.like_count > (prior.like_count || 0)) fields.like_count = cand.like_count;
      if (Object.keys(fields).length) updates.push({ id: prior.id, fields });
      else s.skipped++;
    }
  }

  // Insert new rows (plain insert; 23505 -> benign skip via row-by-row retry).
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500);
    const { error } = await supabase.from("product_videos").insert(chunk);
    if (!error) { s.inserted += chunk.length; continue; }
    if (error.code === "23505") {
      for (const row of chunk) {
        const { error: e2 } = await supabase.from("product_videos").insert(row);
        if (!e2) s.inserted++;
        else if (e2.code === "23505") s.constraintSkipped++;
        else console.error("  [WARN] related insert row failed:", e2.message);
      }
    } else {
      console.error("  [WARN] related insert chunk failed:", error.message);
    }
  }

  // Monotonic count updates via a bounded pool.
  await runPool(updates, CONCURRENCY, async (u) => {
    const { error } = await supabase.from("product_videos").update(u.fields).eq("id", u.id);
    if (error) console.error("  [WARN] related update failed:", error.message);
    else s.updated++;
  });

  return s;
}

// ---------------------------------------------------------------------------
// Target-set selection (all Supabase reads; no credits)
// ---------------------------------------------------------------------------

// Products that already have at least one video row.
async function loadProductsWithVideos() {
  const set = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("product_videos").select("product_id").range(from, from + PAGE - 1);
    if (error) throw new Error("loadProductsWithVideos: " + error.message);
    if (!data?.length) break;
    for (const r of data) set.add(r.product_id);
    if (data.length < PAGE) break;
  }
  return set;
}

// The daily cron's tracked set: top TRACKED_LIMIT by sold_count (to exclude).
async function loadTrackedTopN() {
  const ids = [];
  for (let from = 0; ids.length < TRACKED_LIMIT; from += PAGE) {
    const { data, error } = await supabase.from("products").select("product_id")
      .gt("sold_count", 0).or("price_unavailable.is.null,price_unavailable.eq.false")
      .order("sold_count", { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw new Error("loadTrackedTopN: " + error.message);
    if (!data?.length) break;
    ids.push(...data.map((r) => r.product_id));
    if (data.length < PAGE) break;
  }
  return new Set(ids.slice(0, TRACKED_LIMIT));
}

// Zero-video, untracked, selling products — the pre-trusted candidate pool.
async function loadCandidatePool(hasVideo, trackedTopN) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("products").select("product_id, sold_count")
      .gt("sold_count", 0).order("sold_count", { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw new Error("loadCandidatePool: " + error.message);
    if (!data?.length) break;
    for (const p of data) {
      if (hasVideo.has(p.product_id) || trackedTopN.has(p.product_id)) continue;
      out.push(p);
    }
    if (data.length < PAGE) break;
  }
  return out; // already ordered by sold_count desc
}

// Restrict the candidate pool to TRUSTED products (>=14d history + positive
// 30-day delta), fetching snapshots only for the candidates (not the whole table).
async function filterTrusted(candidates) {
  const ids = candidates.map((c) => c.product_id);
  const cutoff = new Date(Date.now() - SNAPSHOT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const dayCut = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const snaps = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from("product_snapshots")
        .select("product_id, sold_count, snapshot_date")
        .in("product_id", chunk).gte("snapshot_date", cutoff)
        .order("snapshot_date", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error("filterTrusted: " + error.message);
      if (!data?.length) break;
      for (const s of data) { if (!snaps.has(s.product_id)) snaps.set(s.product_id, []); snaps.get(s.product_id).push(s); }
      if (data.length < PAGE) break;
    }
  }
  const trusted = new Set();
  for (const [pid, arr] of snaps) {
    const s = arr.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const span = s.length >= 2 ? (Date.parse(s[s.length - 1].snapshot_date) - Date.parse(s[0].snapshot_date)) / 86400000 : 0;
    if (span < MIN_HISTORY_DAYS) continue;
    for (let i = 1; i < s.length; i++) {
      if (s[i].snapshot_date >= dayCut && (s[i].sold_count || 0) - (s[i - 1].sold_count || 0) > 0) { trusted.add(pid); break; }
    }
  }
  return candidates.filter((c) => trusted.has(c.product_id));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = Date.now();
  console.log(`backfill-related-videos started ${new Date().toISOString()} | region=${REGION} | concurrency=${CONCURRENCY} | tracked-limit=${TRACKED_LIMIT} | limit=${LIMIT === Infinity ? "ALL" : LIMIT}`);

  console.log("Selecting target set (trusted ∩ zero-video ∩ untracked)...");
  const [hasVideo, trackedTopN] = await Promise.all([loadProductsWithVideos(), loadTrackedTopN()]);
  const pool = await loadCandidatePool(hasVideo, trackedTopN);
  console.log(`  zero-video untracked selling products: ${pool.length}`);
  const trusted = await filterTrusted(pool);
  console.log(`  ...of which trusted (>=${MIN_HISTORY_DAYS}d history + positive ${WINDOW_DAYS}d delta): ${trusted.length}`);

  const targets = trusted.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`  processing ${targets.length} products (~${targets.length} credits)\n`);
  if (targets.length === 0) { console.log("Nothing to backfill."); return; }

  const relatedByProduct = new Map();
  const fetchStats = { ok: 0, p404: 0, error: 0, withRelated: 0 };
  let done = 0;
  await runPool(targets, CONCURRENCY, async (p) => {
    const r = await fetchProductDetailRaw(p.product_id);
    done++;
    if (r.status === 404) { fetchStats.p404++; }
    else if (r.status !== 200 || !r.json) { fetchStats.error++; }
    else {
      fetchStats.ok++;
      const rv = r.json.related_videos;
      if (Array.isArray(rv) && rv.length) { relatedByProduct.set(String(p.product_id), rv); fetchStats.withRelated++; }
    }
    if (done % 250 === 0) {
      const rate = (done / ((Date.now() - startedAt) / 1000)).toFixed(1);
      console.log(`  ...${done}/${targets.length} fetched | ok=${fetchStats.ok} 404=${fetchStats.p404} err=${fetchStats.error} with_related=${fetchStats.withRelated} | ${rate}/s`);
    }
  });

  console.log(`\nFetched: ${fetchStats.ok} ok | ${fetchStats.p404} 404 | ${fetchStats.error} errors | ${fetchStats.withRelated} had related_videos`);
  console.log("Upserting related_videos...");
  const rel = await upsertRelatedVideos(relatedByProduct);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`  target products:     ${targets.length}`);
  console.log(`  fetch ok / 404 / err: ${fetchStats.ok} / ${fetchStats.p404} / ${fetchStats.error}`);
  console.log(`  related inserted:    ${rel.inserted}`);
  console.log(`  related updated:     ${rel.updated}`);
  console.log(`  unchanged / dup-skip: ${rel.skipped} / ${rel.constraintSkipped}`);
  console.log(`  candidate videos:    ${rel.candidates} from ${rel.products} products`);
  console.log(`  wall-clock:          ${secs}s`);
  console.log(`backfill-related-videos done ${new Date().toISOString()}`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  if (/fetch failed|ENOTFOUND|NXDOMAIN/i.test(e.message)) {
    console.error("  (Supabase may be auto-paused — resume it from the dashboard and retry.)");
  }
  process.exit(1);
});
