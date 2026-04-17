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

  // Fetch top 100 products by sold_count (with actual sales data)
  const { data: products, error } = await supabase
    .from("products")
    .select("product_id, title, sold_count")
    .gt("sold_count", 0)
    .order("sold_count", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Error fetching products:", error.message);
    process.exit(1);
  }

  console.log(`Found ${products.length} top products to discover videos for\n`);

  const allNewVideos = [];
  let queriesRun = 0;

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
          if (views < 100) continue; // skip very low-view videos

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
          });

          foundForProduct++;
        }
      } catch (err) {
        // skip failed queries silently
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

  // Also update view_count for existing videos that may have grown
  console.log("\nUpdating view counts for existing top videos...");
  let updated = 0;
  for (const product of products.slice(0, 50)) {
    const { data: vids } = await supabase
      .from("product_videos")
      .select("id, video_url, view_count")
      .eq("product_id", product.product_id);

    for (const vid of vids || []) {
      const vidIdMatch = vid.video_url?.match(/video\/(\d+)/);
      if (!vidIdMatch) continue;

      try {
        // Use TikTok oEmbed to get current view count (free, no API key)
        const oembedRes = await fetch(
          `https://www.tiktok.com/oembed?url=${encodeURIComponent(vid.video_url)}`
        );
        if (!oembedRes.ok) continue;
        const oembed = await oembedRes.json();

        // oEmbed doesn't return view count directly, but we can at least
        // update the thumbnail
        if (oembed?.thumbnail_url && oembed.thumbnail_url !== vid.cover_image_url) {
          await supabase
            .from("product_videos")
            .update({ cover_image_url: oembed.thumbnail_url })
            .eq("id", vid.id);
          updated++;
        }
        await sleep(100);
      } catch {
        // skip
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`  New videos inserted: ${inserted}`);
  console.log(`  Thumbnails updated:  ${updated}`);
  console.log(`  API queries run:     ${queriesRun}`);
  console.log(`  Total time:          ${elapsed}s`);
  console.log(`\ndiscover-videos completed at ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
