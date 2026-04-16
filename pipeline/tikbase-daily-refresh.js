/**
 * tikbase-daily-refresh.js
 *
 * Daily pipeline that collects TikTok Shop data via ScrapCreators API
 * and writes to Supabase. 5 phases:
 *   1. Keyword Video Discovery
 *   2. Shop Search Enrichment
 *   3. Snapshot All Products
 *   4. Fill Missing Prices
 *   5. Refresh Thumbnails
 *
 * Usage:  node pipeline/tikbase-daily-refresh.js
 * Requires env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCRAPECREATORS_API_KEY =
  process.env.SCRAPECREATORS_API_KEY;
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SCRAPECREATORS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required env vars: SCRAPECREATORS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const API_BASE = "https://api.scrapecreators.com";
const RATE_LIMIT_MS = 250; // 250ms between API calls

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Summary counters
const stats = {
  phase1_videos: 0,
  phase1_products: 0,
  phase2_products: 0,
  phase3_snapshots: 0,
  phase4_prices_filled: 0,
  phase5_thumbnails: 0,
};

// ---------------------------------------------------------------------------
// Niche definitions
// ---------------------------------------------------------------------------

const NICHE_LABELS = {
  "beauty-skincare": "Beauty & Skincare",
  "gym-fitness": "Gym & Fitness",
  "health-wellness": "Health & Wellness",
  "womens-wear": "Women's Wear",
  "mens-wear": "Men's Wear",
  "tech-gadgets": "Tech & Gadgets",
  "pet-products": "Pet Products",
};

const KEYWORD_QUERIES = {
  "beauty-skincare": [
    "tiktok shop skincare viral",
    "tiktok made me buy it skincare",
    "best tiktok shop beauty products",
    "viral skincare routine tiktok",
    "tiktok shop makeup must haves",
    "beauty finds tiktok shop",
    "skincare holy grail tiktok",
    "tiktok shop beauty haul",
    "trending skincare products tiktok",
    "viral beauty tiktok affiliate",
  ],
  "gym-fitness": [
    "tiktok shop gym must haves",
    "viral fitness products tiktok",
    "tiktok shop workout equipment",
    "gym finds tiktok shop",
    "tiktok made me buy it fitness",
    "home gym tiktok shop",
    "fitness gadgets trending tiktok",
    "viral gym accessories tiktok",
    "tiktok shop protein supplements",
    "workout gear tiktok viral",
    "tiktok shop resistance bands",
    "tiktok shop protein powder viral",
    "tiktok shop leggings gym",
    "creatine tiktok shop",
    "home workout equipment tiktok",
    "tiktok shop dumbbells",
    "massage gun tiktok viral",
    "yoga mat tiktok shop",
    "pre workout tiktok shop",
    "gym accessories viral tiktok",
    "tiktok shop sports bra",
    "fitness tracker tiktok shop",
    "shaker bottle tiktok viral",
    "jump rope tiktok shop",
    "foam roller tiktok viral",
    "weightlifting belt tiktok",
    "compression pants tiktok shop",
    "gym shark tiktok shop",
  ],
  "health-wellness": [
    "tiktok shop health products viral",
    "wellness finds tiktok shop",
    "tiktok made me buy it health",
    "viral supplements tiktok shop",
    "health gadgets tiktok trending",
    "tiktok shop wellness must haves",
    "self care products tiktok shop",
    "health essentials tiktok viral",
    "tiktok shop vitamins trending",
    "wellness routine tiktok shop",
  ],
  "womens-wear": [
    "tiktok shop womens fashion viral",
    "trending womens clothing tiktok",
    "tiktok made me buy it fashion",
    "viral outfits tiktok shop",
    "tiktok shop dress haul",
    "womens fashion finds tiktok",
    "cute clothes tiktok shop",
    "tiktok shop spring outfits",
    "viral womens wear tiktok affiliate",
    "best tiktok shop clothing finds",
  ],
  "mens-wear": [
    "tiktok shop mens fashion viral",
    "mens clothing tiktok shop",
    "tiktok made me buy it mens",
    "viral mens outfits tiktok",
    "mens fashion finds tiktok shop",
    "tiktok shop streetwear trending",
    "mens essentials tiktok shop",
    "guys fashion tiktok viral",
    "best mens tiktok shop finds",
    "mens style tiktok affiliate",
  ],
  "tech-gadgets": [
    "tiktok shop tech gadgets viral",
    "tiktok made me buy it tech",
    "viral gadgets tiktok shop",
    "cool tech finds tiktok",
    "tiktok shop electronics trending",
    "must have gadgets tiktok shop",
    "tech accessories tiktok viral",
    "amazon finds tech tiktok shop",
    "smart home tiktok shop",
    "viral tech products tiktok affiliate",
  ],
  "pet-products": [
    "tiktok shop pet products viral",
    "tiktok made me buy it pets",
    "viral pet finds tiktok shop",
    "dog products tiktok shop trending",
    "cat products tiktok viral",
    "pet must haves tiktok shop",
    "best pet products tiktok",
    "pet accessories tiktok shop",
    "viral pet gadgets tiktok",
    "pet essentials tiktok affiliate",
  ],
};

const SHOP_SEARCH_TERMS = {
  "beauty-skincare": ["skincare", "beauty", "makeup", "serum", "moisturizer"],
  "gym-fitness": [
    "gym equipment",
    "fitness",
    "workout",
    "protein",
    "exercise",
    "resistance bands",
    "dumbbells",
    "yoga mat",
    "creatine",
    "pre workout",
    "leggings gym",
    "sports bra",
    "massage gun",
    "foam roller",
  ],
  "health-wellness": [
    "health supplements",
    "wellness",
    "vitamins",
    "self care",
    "essential oil",
  ],
  "womens-wear": [
    "womens dress",
    "womens fashion",
    "womens clothing",
    "blouse",
    "skirt",
  ],
  "mens-wear": [
    "mens clothing",
    "mens fashion",
    "streetwear",
    "mens shirt",
    "mens pants",
  ],
  "tech-gadgets": [
    "gadgets",
    "tech accessories",
    "electronics",
    "smart home",
    "phone accessories",
  ],
  "pet-products": [
    "dog products",
    "cat products",
    "pet accessories",
    "pet toys",
    "pet grooming",
  ],
};

// ---------------------------------------------------------------------------
// Phase 1 — Keyword Video Discovery
// ---------------------------------------------------------------------------

async function phase1() {
  console.log("\n========== PHASE 1: Keyword Video Discovery ==========\n");

  const videosToUpsert = [];
  const productsToUpsert = [];

  for (const [nicheSlug, queries] of Object.entries(KEYWORD_QUERIES)) {
    const nicheLabel = NICHE_LABELS[nicheSlug];
    console.log(`  Niche: ${nicheLabel} (${queries.length} queries)`);

    for (const query of queries) {
      try {
        const data = await apiFetch(
          `/v1/tiktok/search/keyword?query=${encodeURIComponent(query)}&count=30`
        );
        await sleep(RATE_LIMIT_MS);

        const videos = data?.data || data?.videos || data?.item_list || [];
        if (!Array.isArray(videos)) continue;

        for (const video of videos) {
          const viewCount =
            video?.stats?.playCount ??
            video?.statistics?.play_count ??
            video?.play_count ??
            0;
          if (viewCount < 1000) continue;

          // Look for TikTok Shop product anchor
          const anchors = video?.anchors || video?.anchor_list || [];
          const shopAnchor = anchors.find(
            (a) => a?.extra?.type === 33 || a?.type === 33
          );
          if (!shopAnchor) continue;

          const productId =
            shopAnchor?.extra?.product_id ||
            shopAnchor?.product_id ||
            shopAnchor?.id;
          if (!productId) continue;

          const videoUrl =
            video?.video?.play_addr?.url_list?.[0] ||
            `https://www.tiktok.com/@${video?.author?.unique_id || video?.author?.uniqueId || "user"}/video/${video?.id || video?.aweme_id}`;

          const videoRecord = {
            product_id: String(productId),
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
          };
          videosToUpsert.push(videoRecord);

          // Extract product info from anchor if available
          const productTitle =
            shopAnchor?.extra?.title ||
            shopAnchor?.title ||
            shopAnchor?.description ||
            null;
          if (productTitle) {
            productsToUpsert.push({
              product_id: String(productId),
              title: productTitle,
              niche_slug: nicheSlug,
              niche_label: nicheLabel,
              image_url: shopAnchor?.extra?.image_url || shopAnchor?.icon?.url_list?.[0] || null,
              product_url: shopAnchor?.extra?.product_url || null,
            });
          }
        }
      } catch (err) {
        console.warn(`    [WARN] Query failed "${query}": ${err.message}`);
      }
    }
  }

  // Upsert products
  if (productsToUpsert.length > 0) {
    // Dedupe by product_id
    const dedupedProducts = Object.values(
      productsToUpsert.reduce((acc, p) => {
        acc[p.product_id] = { ...acc[p.product_id], ...p, updated_at: new Date().toISOString() };
        return acc;
      }, {})
    );

    const { error } = await supabase
      .from("products")
      .upsert(dedupedProducts, { onConflict: "product_id", ignoreDuplicates: false });
    if (error) console.error("  [ERROR] Products upsert:", error.message);
    else stats.phase1_products = dedupedProducts.length;
  }

  // Upsert videos
  if (videosToUpsert.length > 0) {
    // Dedupe by video_url
    const dedupedVideos = Object.values(
      videosToUpsert.reduce((acc, v) => {
        acc[v.video_url] = v;
        return acc;
      }, {})
    );

    // Batch upsert in chunks of 500
    for (let i = 0; i < dedupedVideos.length; i += 500) {
      const chunk = dedupedVideos.slice(i, i + 500);
      const { error } = await supabase
        .from("product_videos")
        .upsert(chunk, { onConflict: "video_url", ignoreDuplicates: false });
      if (error) console.error("  [ERROR] Videos upsert:", error.message);
      else stats.phase1_videos += chunk.length;
    }
  }

  console.log(
    `  Phase 1 done: ${stats.phase1_products} products, ${stats.phase1_videos} videos`
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — Shop Search Enrichment
// ---------------------------------------------------------------------------

async function phase2() {
  console.log("\n========== PHASE 2: Shop Search Enrichment ==========\n");

  const productsToUpsert = [];

  for (const [nicheSlug, terms] of Object.entries(SHOP_SEARCH_TERMS)) {
    const nicheLabel = NICHE_LABELS[nicheSlug];
    console.log(`  Niche: ${nicheLabel} (${terms.length} search terms)`);

    for (const term of terms) {
      try {
        const data = await apiFetch(
          `/v1/tiktok/shop/search?query=${encodeURIComponent(term)}`
        );
        await sleep(RATE_LIMIT_MS);

        const products =
          data?.data?.products || data?.products || data?.data || [];
        if (!Array.isArray(products)) continue;

        for (const p of products) {
          const productId =
            p?.product_id || p?.id || p?.item_id;
          if (!productId) continue;

          productsToUpsert.push({
            product_id: String(productId),
            title: p?.title || p?.name || null,
            niche_slug: nicheSlug,
            niche_label: nicheLabel,
            image_url:
              p?.image_url ||
              p?.cover?.url_list?.[0] ||
              p?.images?.[0]?.url_list?.[0] ||
              null,
            sale_price:
              p?.sale_price != null
                ? parseFloat(p.sale_price) || null
                : p?.price?.sale_price != null
                  ? parseFloat(p.price.sale_price) || null
                  : null,
            original_price:
              p?.original_price != null
                ? parseFloat(p.original_price) || null
                : p?.price?.original_price != null
                  ? parseFloat(p.price.original_price) || null
                  : null,
            sold_count: p?.sold_count ?? p?.sales ?? null,
            rating: p?.rating ?? p?.star ?? null,
            review_count: p?.review_count ?? null,
            commission_rate: p?.commission_rate ?? null,
            seller_name: p?.seller?.name || p?.shop?.name || null,
            seller_id: p?.seller?.id || p?.shop?.id || null,
            product_url:
              p?.product_url ||
              p?.url ||
              (productId
                ? `https://shop.tiktok.com/view/product/${productId}`
                : null),
            updated_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn(`    [WARN] Shop search failed "${term}": ${err.message}`);
      }
    }
  }

  if (productsToUpsert.length > 0) {
    const dedupedProducts = Object.values(
      productsToUpsert.reduce((acc, p) => {
        acc[p.product_id] = { ...acc[p.product_id], ...p };
        return acc;
      }, {})
    );

    for (let i = 0; i < dedupedProducts.length; i += 500) {
      const chunk = dedupedProducts.slice(i, i + 500);
      const { error } = await supabase
        .from("products")
        .upsert(chunk, { onConflict: "product_id", ignoreDuplicates: false });
      if (error) console.error("  [ERROR] Shop products upsert:", error.message);
      else stats.phase2_products += chunk.length;
    }
  }

  console.log(`  Phase 2 done: ${stats.phase2_products} products upserted`);
}

// ---------------------------------------------------------------------------
// Phase 3 — Snapshot All Products
// ---------------------------------------------------------------------------

async function phase3() {
  console.log("\n========== PHASE 3: Snapshot All Products ==========\n");

  const snapshotDate = today();

  // Fetch all products
  let allProducts = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("product_id, sold_count, sale_price")
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("  [ERROR] Fetching products:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allProducts = allProducts.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`  Found ${allProducts.length} products to snapshot`);

  const snapshots = allProducts.map((p) => ({
    product_id: p.product_id,
    sold_count: p.sold_count,
    sale_price: p.sale_price,
    snapshot_date: snapshotDate,
  }));

  for (let i = 0; i < snapshots.length; i += 500) {
    const chunk = snapshots.slice(i, i + 500);
    const { error } = await supabase.from("product_snapshots").upsert(chunk, {
      onConflict: "product_id,snapshot_date",
      ignoreDuplicates: false,
    });
    if (error) {
      // If upsert on composite key fails, try insert
      const { error: insertErr } = await supabase
        .from("product_snapshots")
        .insert(chunk);
      if (insertErr)
        console.error("  [ERROR] Snapshots insert:", insertErr.message);
      else stats.phase3_snapshots += chunk.length;
    } else {
      stats.phase3_snapshots += chunk.length;
    }
  }

  console.log(`  Phase 3 done: ${stats.phase3_snapshots} snapshots created`);
}

// ---------------------------------------------------------------------------
// Phase 4 — Fill Missing Prices
// ---------------------------------------------------------------------------

async function phase4() {
  console.log("\n========== PHASE 4: Fill Missing Prices ==========\n");

  // Load fail tracker
  const failTrackerPath = join(__dirname, "price-fail-tracker.json");
  let failTracker = {};
  if (existsSync(failTrackerPath)) {
    try {
      failTracker = JSON.parse(readFileSync(failTrackerPath, "utf8"));
    } catch {
      failTracker = {};
    }
  }

  // Fetch products with missing prices
  const { data: products, error } = await supabase
    .from("products")
    .select("product_id")
    .or("sale_price.is.null,sale_price.eq.0");

  if (error) {
    console.error("  [ERROR] Fetching missing-price products:", error.message);
    return;
  }

  console.log(`  Found ${products?.length || 0} products with missing prices`);

  let filled = 0;
  for (const p of products || []) {
    // Skip if failed 3+ times
    if ((failTracker[p.product_id] || 0) >= 3) continue;

    try {
      const data = await apiFetch(
        `/v1/tiktok/product?product_id=${p.product_id}`
      );
      await sleep(RATE_LIMIT_MS);

      const price =
        data?.data?.product_base?.price?.min_sku_price ??
        data?.product_base?.price?.min_sku_price ??
        null;

      if (price != null && parseFloat(price) > 0) {
        const { error: updateErr } = await supabase
          .from("products")
          .update({
            sale_price: parseFloat(price),
            updated_at: new Date().toISOString(),
          })
          .eq("product_id", p.product_id);

        if (!updateErr) {
          filled++;
          // Remove from fail tracker on success
          delete failTracker[p.product_id];
        }
      } else {
        failTracker[p.product_id] = (failTracker[p.product_id] || 0) + 1;
      }
    } catch (err) {
      console.warn(
        `    [WARN] Price fetch failed for ${p.product_id}: ${err.message}`
      );
      failTracker[p.product_id] = (failTracker[p.product_id] || 0) + 1;
    }
  }

  // Save fail tracker
  writeFileSync(failTrackerPath, JSON.stringify(failTracker, null, 2));

  stats.phase4_prices_filled = filled;
  console.log(`  Phase 4 done: ${filled} prices filled`);
}

// ---------------------------------------------------------------------------
// Phase 5 — Refresh Thumbnails
// ---------------------------------------------------------------------------

async function phase5() {
  console.log("\n========== PHASE 5: Refresh Thumbnails ==========\n");

  const { data: videos, error } = await supabase
    .from("product_videos")
    .select("id, video_url")
    .order("view_count", { ascending: false })
    .limit(200);

  if (error) {
    console.error("  [ERROR] Fetching top videos:", error.message);
    return;
  }

  console.log(`  Refreshing thumbnails for ${videos?.length || 0} videos`);

  let updated = 0;
  for (const v of videos || []) {
    try {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(v.video_url)}`;
      const res = await fetch(oembedUrl);
      await sleep(RATE_LIMIT_MS);

      if (!res.ok) continue;

      const data = await res.json();
      const thumbnailUrl = data?.thumbnail_url;
      if (!thumbnailUrl) continue;

      const { error: updateErr } = await supabase
        .from("product_videos")
        .update({ cover_image_url: thumbnailUrl })
        .eq("id", v.id);

      if (!updateErr) updated++;
    } catch (err) {
      console.warn(
        `    [WARN] oEmbed failed for video ${v.id}: ${err.message}`
      );
    }
  }

  stats.phase5_thumbnails = updated;
  console.log(`  Phase 5 done: ${updated} thumbnails refreshed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log(`tikbase daily refresh started at ${new Date().toISOString()}`);

  await phase1();
  await phase2();
  await phase3();
  await phase4();
  await phase5();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n========== SUMMARY ==========\n");
  console.log(`  Phase 1 — Videos discovered:    ${stats.phase1_videos}`);
  console.log(`  Phase 1 — Products from videos: ${stats.phase1_products}`);
  console.log(`  Phase 2 — Products from shop:   ${stats.phase2_products}`);
  console.log(`  Phase 3 — Snapshots created:    ${stats.phase3_snapshots}`);
  console.log(`  Phase 4 — Prices filled:        ${stats.phase4_prices_filled}`);
  console.log(`  Phase 5 — Thumbnails refreshed: ${stats.phase5_thumbnails}`);
  console.log(`\n  Total time: ${elapsed}s`);
  console.log(`\ntikbase daily refresh completed at ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
