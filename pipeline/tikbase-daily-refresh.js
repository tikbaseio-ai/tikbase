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

        // API returns search_item_list, each item wrapped in aweme_info
        const rawItems = data?.search_item_list || data?.data || [];
        if (!Array.isArray(rawItems)) continue;

        for (const rawItem of rawItems) {
          const video = rawItem?.aweme_info || rawItem;
          const viewCount =
            video?.statistics?.play_count ??
            video?.stats?.playCount ??
            video?.play_count ??
            0;
          if (viewCount < 1000) continue;

          // Look for TikTok Shop product anchor.
          // anchors[].extra is an ARRAY of objects, not a single object.
          const anchors = video?.anchors || video?.anchor_list || [];
          let productId = null;
          let shopExtra = null;
          for (const anchor of anchors) {
            const extras = Array.isArray(anchor?.extra) ? anchor.extra : [anchor?.extra].filter(Boolean);
            const match = extras.find((e) => e?.type === 33);
            if (match) {
              productId = match.id || match.product_id;
              shopExtra = match;
              break;
            }
          }
          // Fallback: check shop_product_url for product ID
          if (!productId && video?.shop_product_url) {
            const m = video.shop_product_url.match(/\/(\d{10,})/);
            if (m) productId = m[1];
          }
          if (!productId) continue;

          const videoUrl =
            `https://www.tiktok.com/@${video?.author?.unique_id || video?.author?.uniqueId || "user"}/video/${video?.aweme_id || video?.id}`;

          const videoRecord = {
            product_id: String(productId),
            video_url: videoUrl,
            view_count: viewCount,
            author_name:
              video?.author?.nickname ||
              video?.author?.unique_id ||
              null,
            author_avatar_url:
              video?.author?.avatar_medium?.url_list?.[0] ||
              video?.author?.avatar_thumb?.url_list?.[0] ||
              null,
            cover_image_url:
              video?.video?.cover?.url_list?.[0] ||
              video?.video?.origin_cover?.url_list?.[0] ||
              null,
          };
          videosToUpsert.push(videoRecord);

          // Extract product info from anchor
          const productTitle = shopExtra?.keyword || shopExtra?.title || null;
          productsToUpsert.push({
            product_id: String(productId),
            title: productTitle,
            niche_slug: nicheSlug,
            niche_label: nicheLabel,
            image_url: video?.video?.cover?.url_list?.[0] || null,
            product_url: video?.shop_product_url || `https://www.tiktok.com/shop/pdp/${productId}`,
          });
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
    // product_videos has no unique constraint on video_url, so we check
    // which URLs already exist and only insert new ones.
    const allUrls = dedupedVideos.map((v) => v.video_url);
    const existingUrls = new Set();
    for (let i = 0; i < allUrls.length; i += 500) {
      const batch = allUrls.slice(i, i + 500);
      const { data: existing } = await supabase
        .from("product_videos")
        .select("video_url")
        .in("video_url", batch);
      if (existing) existing.forEach((r) => existingUrls.add(r.video_url));
    }
    const newVideos = dedupedVideos.filter((v) => !existingUrls.has(v.video_url));
    for (let i = 0; i < newVideos.length; i += 500) {
      const chunk = newVideos.slice(i, i + 500);
      const { error } = await supabase
        .from("product_videos")
        .insert(chunk);
      if (error) console.error("  [ERROR] Videos insert:", error.message);
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

          // Extract price from product_price_info (shop search response shape)
          const priceInfo = p?.product_price_info;
          const salePrice = priceInfo?.min_price != null
            ? parseFloat(String(priceInfo.min_price).replace(/[^0-9.]/g, '')) || null
            : p?.sale_price != null ? parseFloat(p.sale_price) || null : null;
          const originalPrice = priceInfo?.original_price != null
            ? parseFloat(String(priceInfo.original_price).replace(/[^0-9.]/g, '')) || null
            : p?.original_price != null ? parseFloat(p.original_price) || null : null;

          // Extract sold count from sold_info
          const soldText = p?.sold_info?.sold_count_str || "";
          let soldCount = null;
          if (soldText) {
            const cleaned = soldText.replace(/[,+]/g, '');
            const m = cleaned.match(/([\d.]+)\s*([KkMm])?/);
            if (m) {
              let n = parseFloat(m[1]);
              if (m[2] && /[Kk]/.test(m[2])) n *= 1000;
              if (m[2] && /[Mm]/.test(m[2])) n *= 1000000;
              soldCount = Math.round(n);
            }
          }

          productsToUpsert.push({
            product_id: String(productId),
            title: p?.title || p?.name || null,
            niche_slug: nicheSlug,
            niche_label: nicheLabel,
            image_url:
              p?.image?.url_list?.[0] ||
              p?.image_url ||
              null,
            sale_price: salePrice,
            original_price: originalPrice,
            sold_count: soldCount ?? p?.sold_count ?? null,
            rating: p?.rate_info?.star ? parseFloat(p.rate_info.star) : (p?.rating ?? null),
            review_count: p?.rate_info?.review_count ?? p?.review_count ?? null,
            seller_name: p?.seller_info?.name || p?.seller?.name || null,
            seller_id: p?.seller_info?.seller_id || p?.seller?.id || null,
            product_url: `https://www.tiktok.com/shop/pdp/${productId}`,
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
      // API expects a URL, not a bare product_id
      const productUrl = `https://www.tiktok.com/shop/pdp/${p.product_id}`;
      const data = await apiFetch(
        `/v1/tiktok/product?url=${encodeURIComponent(productUrl)}`
      );
      await sleep(RATE_LIMIT_MS);

      const price =
        data?.product_base?.price?.min_sku_price ??
        data?.data?.product_base?.price?.min_sku_price ??
        null;

      if (price != null && parseFloat(price) > 0) {
        const pb = data?.product_base;
        const updateFields = {
          sale_price: parseFloat(price),
          updated_at: new Date().toISOString(),
        };
        // Also fill other fields if available
        if (pb?.price?.original_price) {
          const op = parseFloat(String(pb.price.original_price).replace(/[^0-9.]/g, ''));
          if (op > 0) updateFields.original_price = op;
        }
        if (pb?.sold_count != null) updateFields.sold_count = pb.sold_count;
        if (pb?.title && !p.title) updateFields.title = pb.title;
        if (pb?.images?.[0]?.url_list?.[0]) updateFields.image_url = pb.images[0].url_list[0];
        if (data?.seller?.name) updateFields.seller_name = data.seller.name;
        if (data?.seller?.seller_id) updateFields.seller_id = data.seller.seller_id;

        const { error: updateErr } = await supabase
          .from("products")
          .update(updateFields)
          .eq("product_id", p.product_id);

        if (!updateErr) {
          filled++;
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
