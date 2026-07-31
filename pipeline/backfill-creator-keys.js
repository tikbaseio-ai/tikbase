/**
 * backfill-creator-keys.js — stamp creator_key on the product_videos rows that
 * were inserted without one.
 *
 * The 2026-07-28 migration backfilled the column once and installed no trigger,
 * and nothing on the write path set it, so every row inserted after that date
 * stayed null. precompute-creators drops unkeyed rows
 * (`.not('creator_key','is',null)`), which meant the creator leaderboard was
 * quietly ignoring every video discovered since — 30,384 rows (8.78%) when this
 * was found on 2026-07-30.
 *
 * The write path is fixed at the source now (shared/creator-key.js is called by
 * every product_videos insert). This closes the gap that already accumulated.
 *
 * Safe to run repeatedly and safe to interrupt:
 *   - only touches rows where creator_key IS NULL, so re-running is a no-op over
 *     rows it already stamped,
 *   - commits in small batches, so a statement timeout costs one batch and the
 *     progress before it stands,
 *   - rows whose URL yields no key (phase 1's '@user' placeholder) can't be
 *     stamped; they are counted and skipped rather than retried forever, and the
 *     scan advances past them by id.
 *
 * Usage:
 *   node --env-file=.env pipeline/backfill-creator-keys.js
 *   node --env-file=.env pipeline/backfill-creator-keys.js --dry-run
 */
import { createClient } from "@supabase/supabase-js";
import { deriveCreatorKey } from "../shared/creator-key.js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DRY_RUN = process.argv.includes("--dry-run");
// Small enough that one page of `creator_key is null` stays under the statement
// timeout. The filter is not index-served (the index is partial ON the not-null
// rows), so each page is a filtered walk and asking for too much at once is
// exactly what cancels.
const PAGE = 200;
const UPDATE_CONCURRENCY = 8;

async function runPool(items, concurrency, worker) {
  let i = 0;
  const runner = async () => {
    while (i < items.length) await worker(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
}

// An exact count over `creator_key is null` is itself an unindexed walk and can
// cancel on statement timeout, so treat it as a nice-to-have, not a gate.
async function countUnkeyed() {
  const { count, error } = await supabase
    .from("product_videos")
    .select("*", { count: "exact", head: true })
    .is("creator_key", null);
  if (error || count === null || count === undefined) return null;
  return count;
}

async function main() {
  const started = Date.now();
  const before = await countUnkeyed();
  console.log(
    `backfill-creator-keys started ${new Date().toISOString()}` +
    `${DRY_RUN ? " | DRY RUN" : ""}\n  unkeyed rows: ${before ?? "unavailable (count timed out)"}`,
  );

  let cursor = "";
  let seen = 0;
  let stamped = 0;
  let unkeyable = 0;
  let failed = 0;
  let emptyPages = 0;

  for (;;) {
    let q = supabase
      .from("product_videos")
      .select("id,video_url")
      .is("creator_key", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;

    if (error) {
      // A timeout here is expected occasionally on this unindexed filter. The
      // rows already stamped stay stamped; stop cleanly and report.
      console.warn(`  [WARN] scan stopped: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;

    seen += data.length;
    const work = [];
    for (const row of data) {
      const key = deriveCreatorKey(row.video_url);
      if (!key) {
        unkeyable++;
        continue;
      }
      work.push({ id: row.id, key });
    }

    if (!DRY_RUN && work.length) {
      await runPool(work, UPDATE_CONCURRENCY, async ({ id, key }) => {
        const { error: upErr } = await supabase
          .from("product_videos")
          .update({ creator_key: key })
          .eq("id", id);
        if (upErr) {
          failed++;
          if (failed <= 5) console.warn(`  [WARN] update ${id}: ${upErr.message}`);
        } else {
          stamped++;
        }
      });
    } else if (DRY_RUN) {
      stamped += work.length;
    }

    cursor = data[data.length - 1].id;
    if (data.length < PAGE) emptyPages++;
    if (emptyPages > 2) break;

    if (seen % 2000 === 0 || data.length < PAGE) {
      console.log(
        `  scanned ${seen} | stamped ${stamped} | unkeyable ${unkeyable} | failed ${failed}`,
      );
    }
  }

  const after = await countUnkeyed();

  console.log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s` +
    `\n  scanned          : ${seen}` +
    `\n  stamped          : ${stamped}${DRY_RUN ? " (dry run — nothing written)" : ""}` +
    `\n  unkeyable (@user): ${unkeyable}` +
    `\n  failed           : ${failed}` +
    `\n  unkeyed rows     : ${before ?? "?"} -> ${after ?? "?"}`,
  );
  if (!DRY_RUN && (after ?? 0) > 0 && stamped > 0) {
    console.log("  Re-run to continue if the scan stopped early; it is idempotent.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
