/**
 * discover-videos.js
 *
 * Finds TikTok videos for top products by searching product names.
 * This is critical for accurate view counts — keyword search in the
 * main pipeline only finds a small fraction of videos for each product.
 *
 * Usage:  node pipeline/discover-videos.js
 * Requires env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY;
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SCRAPECREATORS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const API_BASE = "https://api.scrapecreators.com";
const RATE_LIMIT_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "x-api-key": SCRAPECREATORS_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Query generation from product title
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "of", "in", "on", "to",
  "is", "it", "by", "at", "from", "as", "this", "that", "set", "pack",
  "pcs", "pc", "oz", "ml", "g", "kg", "lb", "new", "hot", "sale",
  "official", "shop", "store", "best", "top", "premium", "quality",
]);

function generateQueries(title) {
  if (!title) return [];
  const queries = [];

  // Clean the title
  const cleaned = title
    .replace(/\[.*?\]/g, " ")    // remove [brackets]
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));

  // Query 1: First 4-5 meaningful words (most specific)
  if (meaningful.length >= 2) {
    queries.push(meaningful.slice(0, 5).join(" "));
  }

  // Query 2: Brand + product type (e.g. "OVER SELF Treadmill")
  const brandWords = [];
  for (const w of words) {
    if (/^[A-Z]/.test(w) && !STOP_WORDS.has(w.toLowerCase())) {
      brandWords.push(w);
      if (brandWords.length >= 2) break;
    } else if (brandWords.length > 0) break;
  }
  if (brandWords.length > 0 && meaningful.length > brandWords.length) {
    // Add a product-type word from later in the title
    const typeWords = meaningful.filter((w) => !brandWords.includes(w)).slice(0, 2);
    if (typeWords.length > 0) {
      queries.push(brandWords.join(" ") + " " + typeWords.join(" ") + " tiktok");
    }
  }

  // Query 3: Product name + "tiktok shop"
  if (meaningful.length >= 2) {
    queries.push(meaningful.slice(0, 3).join(" ") + " tiktok shop");
  }

  return [...new Set(queries)].slice(0, 3);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log(`discover-videos started at ${new Date().toISOString()}\n`);

  // Target the products that actually appear in the rankings users see but
  // have too few videos to estimate reliably. We read the precomputed
  // rankings_cache (exactly what the site displays), collect under-covered
  // products, and prioritise the highest-ranked ones by revenue.
  //
  // The old version only covered the top 100 by lifetime sold_count — those
  // are already video-rich mega-sellers and are rarely what ranks by revenue,
  // so high-revenue products (e.g. a $160 car seat with 1 video) never got
  // discovery and stayed stuck at 1 video.
  const MIN_VIDEOS = Number(process.env.DISCOVER_MIN_VIDEOS) || 3;
  // Storage floor: drop true junk (bot/throwaway clips) but keep real
  // small-creator content — on a video-starved product, a 5K-view clip is
  // signal for affiliates, not pollution. The product page already sorts by
  // views and shows only the top 5, so low-view rows never surface on a
  // well-covered product; they only ever fill an otherwise-empty page.
  const MIN_VIEWS = Number(process.env.DISCOVER_MIN_VIEWS) || 1000;
  const DISCOVER_LIMIT = Number(process.env.DISCOVER_LIMIT) || 400;

  // List the ranking keys first (lightweight — no payloads), then read each
  // payload individually. Fetching all payloads at once times out because each
  // is a large 400-product JSON blob.
  const { data: keyRows, error } = await supabase
    .from("rankings_cache")
    .select("cache_key")
    .like("cache_key", "products:%");

  if (error) {
    console.error("Error reading rankings_cache:", error.message);
    process.exit(1);
  }

  // Dedupe by product_id across all niche/timeframe rankings, keeping the
  // highest estimated revenue seen (so we discover top-displayed products first).
  const candidates = new Map();
  for (const { cache_key } of keyRows || []) {
    const { data: one, error: rowErr } = await supabase
      .from("rankings_cache")
      .select("payload")
      .eq("cache_key", cache_key)
      .maybeSingle();
    if (rowErr || !one) continue;
    for (const p of one.payload || []) {
      if (!p || !p.product_id) continue;
      const vidCount = Array.isArray(p.topVideos) ? p.topVideos.length : 0;
      if (vidCount >= MIN_VIDEOS) continue; // already has enough videos
      const score = p.metrics?.estRevenue || 0;
      const prev = candidates.get(p.product_id);
      if (!prev || score > prev.score) {
        candidates.set(p.product_id, { product_id: p.product_id, title: p.title, score });
      }
    }
  }

  const products = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, DISCOVER_LIMIT);

  console.log(
    `${candidates.size} under-covered products in rankings (<${MIN_VIDEOS} videos); discovering for top ${products.length} by revenue\n`,
  );

  const allNewVideos = [];
  let queriesRun = 0;
  // Failed calls were previously swallowed with no log and no count, so a
  // credit wall was indistinguishable from "found nothing". Count them, and
  // treat a 402 (out of credits) as the account-level outage it is.
  let apiFailures = 0, credit402 = 0, loggedFailures = 0;

  for (const product of products) {
    const queries = generateQueries(product.title);
    if (queries.length === 0) continue;

    // Get existing video URLs for this product to avoid re-inserting
    const { data: existing } = await supabase
      .from("product_videos")
      .select("video_url")
      .eq("product_id", product.product_id);
    const existingUrls = new Set((existing || []).map((v) => v.video_url));

    let foundForProduct = 0;

    for (const query of queries) {
      try {
        const data = await apiFetch(
          `/v1/tiktok/search/keyword?query=${encodeURIComponent(query)}&count=30`
        );
        await sleep(RATE_LIMIT_MS);
        queriesRun++;

        // API returns search_item_list[].aweme_info
        const rawItems = data?.search_item_list || [];
        if (!Array.isArray(rawItems)) continue;

        for (const rawItem of rawItems) {
          const video = rawItem?.aweme_info || rawItem;

          // Check if this video links to our product
          let matchesProduct = false;

          // Method 1: Direct product link via anchor (type 33)
          for (const anchor of video?.anchors || []) {
            const extras = Array.isArray(anchor?.extra)
              ? anchor.extra
              : [anchor?.extra].filter(Boolean);
            for (const e of extras) {
              if (e?.type === 33 && String(e?.id) === String(product.product_id)) {
                matchesProduct = true;
                break;
              }
            }
            if (matchesProduct) break;
          }

          // Method 2: shop_product_url contains our product_id
          if (
            !matchesProduct &&
            video?.shop_product_url?.includes(product.product_id)
          ) {
            matchesProduct = true;
          }

          if (!matchesProduct) continue;

          const views = video?.statistics?.play_count || 0;
          if (views < MIN_VIEWS) continue; // skip junk; keep real small-creator content

          const videoUrl = `https://www.tiktok.com/@${
            video?.author?.unique_id || "user"
          }/video/${video?.aweme_id || video?.id}`;

          if (existingUrls.has(videoUrl)) continue;
          existingUrls.add(videoUrl); // prevent dupes within this run

          allNewVideos.push({
            product_id: String(product.product_id),
            video_url: videoUrl,
            view_count: views,
            author_name: video?.author?.nickname || null,
            author_avatar_url:
              video?.author?.avatar_medium?.url_list?.[0] || null,
            cover_image_url: video?.video?.cover?.url_list?.[0] || null,
            // Tag provenance so this path can be isolated from Phase 1 keyword
            // discovery (which leaves discovery_source at its 'keyword' default).
            discovery_source: "discover_videos",
          });

          foundForProduct++;
        }
      } catch (err) {
        apiFailures++;
        if (/\bAPI 402\b|out of credits/i.test(String(err?.message || ""))) credit402++;
        // Log the first few verbatim, then suppress: a credit wall fails every
        // query and would otherwise bury the log in hundreds of identical lines.
        if (loggedFailures < 5) {
          loggedFailures++;
          console.warn(`    [WARN] Query failed for ${product.product_id}: ${err.message}`);
          if (loggedFailures === 5) console.warn("    [WARN] (further query failures suppressed; see summary)");
        }
      }
    }

    if (foundForProduct > 0) {
      console.log(
        `  ✔ ${product.title?.slice(0, 50)} → ${foundForProduct} new videos`
      );
    }
  }

  console.log(
    `\nFound ${allNewVideos.length} new videos from ${queriesRun} queries`
  );

  // Insert new videos (check-then-insert since no unique constraint)
  let inserted = 0;
  for (let i = 0; i < allNewVideos.length; i += 500) {
    const chunk = allNewVideos.slice(i, i + 500);
    const { error: insertErr } = await supabase
      .from("product_videos")
      .insert(chunk);
    if (insertErr) {
      console.error("  [ERROR] Insert:", insertErr.message);
    } else {
      inserted += chunk.length;
    }
  }

  // Optional thumbnail refresh via TikTok oEmbed. OFF by default: oEmbed calls
  // are slow/unreliable and previously ran with no timeout on every video,
  // stalling the job for hours. When enabled, it is hard-bounded by a
  // per-request timeout and a total-call cap so it can never hang the pipeline.
  let updated = 0;
  if (process.env.REFRESH_THUMBNAILS === "1") {
    const OEMBED_TIMEOUT_MS = 5000;
    const OEMBED_MAX_CALLS = Number(process.env.OEMBED_MAX_CALLS) || 300;
    let calls = 0;
    console.log("\nRefreshing thumbnails via oEmbed (bounded)...");
    outer: for (const product of products.slice(0, 50)) {
      const { data: vids } = await supabase
        .from("product_videos")
        .select("id, video_url, cover_image_url")
        .eq("product_id", product.product_id);

      for (const vid of vids || []) {
        if (calls >= OEMBED_MAX_CALLS) break outer;
        if (!vid.video_url?.match(/video\/(\d+)/)) continue;
        calls++;
        try {
          const oembedRes = await fetch(
            `https://www.tiktok.com/oembed?url=${encodeURIComponent(vid.video_url)}`,
            { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) },
          );
          if (!oembedRes.ok) continue;
          const oembed = await oembedRes.json();
          if (oembed?.thumbnail_url && oembed.thumbnail_url !== vid.cover_image_url) {
            await supabase
              .from("product_videos")
              .update({ cover_image_url: oembed.thumbnail_url })
              .eq("id", vid.id);
            updated++;
          }
        } catch {
          // timeout or network error — skip
        }
        await sleep(100);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`  New videos inserted: ${inserted}`);
  console.log(`  Thumbnails updated:  ${updated}`);
  console.log(`  API queries run:     ${queriesRun}`);
  console.log(`  API failures:        ${apiFailures} (402 / credit wall: ${credit402})`);
  console.log(`  Total time:          ${elapsed}s`);
  console.log(`\ndiscover-videos completed at ${new Date().toISOString()}`);

  // Exit non-zero on a credit wall: 0 videos because the account is out of
  // credits is a failure, not a clean "nothing new to find".
  if (credit402 > 0) {
    console.error(
      `\n${"!".repeat(60)}\n` +
      `CREDIT WALL: ${credit402} of ${apiFailures} failed calls were HTTP 402.\n` +
      `402 = out of credits OR an invalid/revoked API key (the vendor returns it for both).\n` +
      `Discovery did NOT run to completion — only ${queriesRun} queries succeeded.\n` +
      `${"!".repeat(60)}`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
