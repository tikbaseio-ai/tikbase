/**
 * discover-videos.js
 *
 * Supplemental script that finds TikTok videos for the top 50 products
 * by sold_count. Generates search queries from product titles and matches
 * videos via direct product links or fuzzy title matching.
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
const RATE_LIMIT_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "x-api-key": SCRAPECREATORS_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status} for ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Query generation from product title
// ---------------------------------------------------------------------------

/** Common filler words to strip when building search queries */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "of", "in", "on", "to",
  "is", "it", "by", "at", "from", "as", "this", "that", "set", "pack",
  "pcs", "pc", "oz", "ml", "g", "kg", "lb", "new", "hot", "sale",
]);

function generateQueries(title) {
  if (!title) return [];
  const queries = [];

  const words = title
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  // Query 1: Brand name — assume first word(s) that start with uppercase are the brand
  const brandWords = [];
  for (const w of words) {
    if (/^[A-Z]/.test(w) && !STOP_WORDS.has(w.toLowerCase())) {
      brandWords.push(w);
      if (brandWords.length >= 2) break;
    } else if (brandWords.length > 0) {
      break;
    }
  }
  if (brandWords.length > 0) {
    queries.push(`${brandWords.join(" ")} tiktok shop`);
  }

  // Query 2: First 3 meaningful words
  const meaningful = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  if (meaningful.length >= 2) {
    queries.push(meaningful.slice(0, 3).join(" ") + " tiktok");
  }

  // Query 3: Product type keywords (last 2-3 meaningful words, likely the product type)
  if (meaningful.length >= 3) {
    queries.push(
      meaningful.slice(-3).join(" ") + " tiktok shop"
    );
  }

  // Deduplicate and limit to 3
  const unique = [...new Set(queries)];
  return unique.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Fuzzy matching: check if 2+ product title words appear in video description
// ---------------------------------------------------------------------------

function fuzzyMatch(productTitle, videoDesc) {
  if (!productTitle || !videoDesc) return false;

  const productWords = productTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const descLower = videoDesc.toLowerCase();
  let matchCount = 0;

  for (const word of productWords) {
    if (descLower.includes(word)) matchCount++;
    if (matchCount >= 2) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log(
    `discover-videos started at ${new Date().toISOString()}\n`
  );

  // Fetch top 50 products by sold_count
  const { data: products, error } = await supabase
    .from("products")
    .select("product_id, title")
    .order("sold_count", { ascending: false })
    .limit(50);

  if (error) {
    console.error("Error fetching products:", error.message);
    process.exit(1);
  }

  console.log(`Found ${products.length} top products\n`);

  const videosToUpsert = [];
  let queriesRun = 0;

  for (const product of products) {
    const queries = generateQueries(product.title);
    if (queries.length === 0) {
      console.log(`  Skipping "${product.title?.slice(0, 50)}" — no queries generated`);
      continue;
    }

    console.log(
      `  Product: "${product.title?.slice(0, 50)}..." — ${queries.length} queries`
    );

    for (const query of queries) {
      try {
        const data = await apiFetch(
          `/v1/tiktok/search/keyword?query=${encodeURIComponent(query)}&count=30`
        );
        await sleep(RATE_LIMIT_MS);
        queriesRun++;

        const videos = data?.data || data?.videos || data?.item_list || [];
        if (!Array.isArray(videos)) continue;

        for (const video of videos) {
          let matched = false;

          // Method 1: Direct product link match via anchor
          const anchors = video?.anchors || video?.anchor_list || [];
          const shopAnchor = anchors.find(
            (a) => a?.extra?.type === 33 || a?.type === 33
          );
          if (shopAnchor) {
            const anchorProductId =
              shopAnchor?.extra?.product_id ||
              shopAnchor?.product_id ||
              shopAnchor?.id;
            if (String(anchorProductId) === String(product.product_id)) {
              matched = true;
            }
          }

          // Method 2: Fuzzy title matching
          if (!matched) {
            const desc =
              video?.desc ||
              video?.description ||
              video?.title ||
              "";
            if (fuzzyMatch(product.title, desc)) {
              matched = true;
            }
          }

          if (!matched) continue;

          const viewCount =
            video?.stats?.playCount ??
            video?.statistics?.play_count ??
            video?.play_count ??
            0;

          const videoUrl =
            video?.video?.play_addr?.url_list?.[0] ||
            `https://www.tiktok.com/@${video?.author?.unique_id || video?.author?.uniqueId || "user"}/video/${video?.id || video?.aweme_id}`;

          videosToUpsert.push({
            product_id: String(product.product_id),
            video_url: videoUrl,
            view_count: viewCount,
            author_name:
              video?.author?.nickname ||
              video?.author?.unique_id ||
              video?.author?.uniqueId ||
              null,
            author_avatar_url:
              video?.author?.avatar_thumb?.url_list?.[0] ||
              video?.author?.avatarThumb ||
              null,
            cover_image_url:
              video?.video?.cover?.url_list?.[0] ||
              video?.video?.originCover ||
              null,
          });
        }
      } catch (err) {
        console.warn(`    [WARN] Query failed "${query}": ${err.message}`);
      }
    }
  }

  // Dedupe by video_url
  const dedupedVideos = Object.values(
    videosToUpsert.reduce((acc, v) => {
      acc[v.video_url] = v;
      return acc;
    }, {})
  );

  console.log(
    `\nFound ${dedupedVideos.length} videos from ${queriesRun} queries`
  );

  // Upsert in batches
  let upserted = 0;
  for (let i = 0; i < dedupedVideos.length; i += 500) {
    const chunk = dedupedVideos.slice(i, i + 500);
    const { error: upsertErr } = await supabase
      .from("product_videos")
      .upsert(chunk, { onConflict: "video_url", ignoreDuplicates: false });
    if (upsertErr) {
      console.error("  [ERROR] Videos upsert:", upsertErr.message);
    } else {
      upserted += chunk.length;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nUpserted ${upserted} videos in ${elapsed}s`);
  console.log(`discover-videos completed at ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
