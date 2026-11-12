/**
 * How many ScrapeCreators calls one daily run is allowed to make.
 *
 * The historical default is 1,500 hot snapshots + 4,500 rotation snapshots,
 * plus the fixed phase 1 / phase 2 / phase 4 lookups, plus video discovery
 * when DISCOVER_LIMIT is set. DAILY_CALL_BUDGET is a ceiling on that sum.
 * Snapshots absorb the cut (hot and rotation keep their ratio). Unset, blank,
 * or absent leaves the historical defaults alone.
 *
 * SNAPSHOT_HOT_LIMIT and SNAPSHOT_ROTATION_LIMIT still pin a tier when set.
 * A budget smaller than those pins shrinks them; a budget larger does not
 * grow them. SNAPSHOT_TRACKED_LIMIT remains the legacy combined cap — phase 3
 * fetches that many products and ignores the separate tier sizes except as a
 * ratio — so a budget has to lower the cap itself or it would not bind.
 */

export const DEFAULT_SNAPSHOT_HOT = 1500;
export const DEFAULT_SNAPSHOT_ROTATION = 4500;
// Phase 4's own ceiling. One product detail call each, and the phase stops
// there even when more products are missing a price.
export const PHASE4_MAX_LOOKUPS = 200;
// generateQueries() in discover-videos.js keeps at most this many searches
// per product. The preflight uses the ceiling, not the average.
export const DISCOVER_QUERIES_PER_PRODUCT = 3;

function positiveInt(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number(text);
  // `Number(x) || default` in the pipeline treats 0 and NaN as "unset".
  // Keep that, so an empty workflow input does not become a zero budget.
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseBudget(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `DAILY_CALL_BUDGET must be a whole number of credits (got ${JSON.stringify(raw)}). ` +
      `Refusing to guess — an ignored typo would spend the full default.`,
    );
  }
  return Number(text);
}

export function countQueryGroups(groups) {
  let n = 0;
  for (const list of Object.values(groups || {})) {
    if (Array.isArray(list)) n += list.length;
  }
  return n;
}

/**
 * @param {object} opts
 * @param {number} opts.phase1Calls
 * @param {number} opts.phase2Calls
 * @param {string|number|undefined} [opts.hotRaw]
 * @param {string|number|undefined} [opts.rotationRaw]
 * @param {string|number|undefined} [opts.trackedRaw]
 * @param {string|number|undefined} [opts.budgetRaw]
 * @param {string|number|undefined} [opts.discoverLimitRaw]
 * @param {number} [opts.phase4Calls]
 * @param {number} [opts.queriesPerProduct]
 */
export function resolveCallPlan(opts) {
  const phase1Calls = opts.phase1Calls;
  const phase2Calls = opts.phase2Calls;
  const phase4Calls = opts.phase4Calls ?? PHASE4_MAX_LOOKUPS;
  const queriesPerProduct = opts.queriesPerProduct ?? DISCOVER_QUERIES_PER_PRODUCT;

  const hotPinned = positiveInt(opts.hotRaw);
  const rotationPinned = positiveInt(opts.rotationRaw);
  let hot = hotPinned ?? DEFAULT_SNAPSHOT_HOT;
  let rotation = rotationPinned ?? DEFAULT_SNAPSHOT_ROTATION;
  let tracked = positiveInt(opts.trackedRaw) ?? 0;

  const discoverProducts = positiveInt(opts.discoverLimitRaw) ?? 0;
  const discoverCalls = discoverProducts * queriesPerProduct;
  const overhead = phase1Calls + phase2Calls + phase4Calls + discoverCalls;

  const budget = parseBudget(opts.budgetRaw);
  let scaled = false;

  if (budget !== null) {
    const room = Math.max(0, budget - overhead);
    const ceiling = tracked > 0 ? tracked : hot + rotation;
    if (ceiling > room) {
      scaled = true;
      const share = (hot + rotation) > 0 ? hot / (hot + rotation) : 0;
      if (tracked > 0) tracked = room;
      hot = Math.round(room * share);
      rotation = Math.max(0, room - hot);
    }
  }

  const snapshotCalls = tracked > 0 ? tracked : hot + rotation;
  const total = overhead + snapshotCalls;

  return {
    phase1Calls,
    phase2Calls,
    phase4Calls,
    hot,
    rotation,
    tracked,
    discoverProducts,
    discoverCalls,
    overhead,
    snapshotCalls,
    total,
    budget,
    scaled,
  };
}

// Null when the budget can hold the plan. A string when the fixed lookups
// (phases 1, 2, 4, discovery) already exceed it and snapshots are at their
// floor — the run must stop before the credit probe.
export function budgetShortfall(plan) {
  if (plan.budget === null || plan.total <= plan.budget) return null;
  return (
    `PREFLIGHT STOP: DAILY_CALL_BUDGET=${plan.budget.toLocaleString("en-US")} ` +
    `is below ${plan.total.toLocaleString("en-US")} credits, and the snapshot tiers are already at ` +
    `${plan.snapshotCalls.toLocaleString("en-US")}.\n` +
    `The remainder is phase 1, phase 2, price lookups, and video discovery, which this knob does not drop.\n` +
    `Raise the budget or lower DISCOVER_LIMIT. No data calls were made.`
  );
}

export function formatCallPlan(plan) {
  const snapshots =
    plan.tracked > 0
      ? `${plan.snapshotCalls.toLocaleString("en-US")} (tracked cap; hot/rotation ratio ${plan.hot.toLocaleString("en-US")}:${plan.rotation.toLocaleString("en-US")})`
      : `${plan.snapshotCalls.toLocaleString("en-US")} (hot ${plan.hot.toLocaleString("en-US")} + rotation ${plan.rotation.toLocaleString("en-US")})`;
  const lines = [
    `Call plan: phase 1 ${plan.phase1Calls.toLocaleString("en-US")}` +
      ` + phase 2 ${plan.phase2Calls.toLocaleString("en-US")}` +
      ` + snapshots ${snapshots}` +
      ` + price lookups up to ${plan.phase4Calls.toLocaleString("en-US")}` +
      ` + video discovery up to ${plan.discoverCalls.toLocaleString("en-US")}` +
      ` = ${plan.total.toLocaleString("en-US")} credits.`,
  ];
  if (plan.budget !== null) {
    lines.push(
      `DAILY_CALL_BUDGET=${plan.budget.toLocaleString("en-US")}` +
        (plan.scaled
          ? ` — snapshot tiers scaled down from the ${DEFAULT_SNAPSHOT_HOT.toLocaleString("en-US")}+${DEFAULT_SNAPSHOT_ROTATION.toLocaleString("en-US")} default.`
          : ` — within the default snapshot tiers, nothing scaled.`),
    );
  }
  if (plan.scaled && plan.rotation < DEFAULT_SNAPSHOT_ROTATION) {
    // The 7-day delta accepts a baseline→latest span of 4.7–10.5 days
    // (MAX_SPAN_RATIO 1.5 in api/top-products.ts). The 4,500/day rotation was
    // sized to clear the eligible tail inside that window. A shorter rotation
    // does not, and the page then shows a modelled figure where it used to
    // show a measured one. Say so before the credits are spent.
    lines.push(
      `BUDGET WARNING: rotation is ${plan.rotation.toLocaleString("en-US")}/day, down from ${DEFAULT_SNAPSHOT_ROTATION.toLocaleString("en-US")}. ` +
        `A 7-day delta needs each product re-snapshotted about every 10.5 days. ` +
        `A shorter rotation lengthens that cycle, so more products will show a modelled figure. ` +
        `The end-of-run membership monitor counts anyone past 9 days.`,
    );
  }
  return lines.join("\n");
}
