/**
 * The daily call ceiling. A wrong default spends 6,000 credits; a budget that
 * fails to shrink the tracked cap spends them anyway, because phase 3 treats
 * SNAPSHOT_TRACKED_LIMIT as the fetch count.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SNAPSHOT_HOT,
  DEFAULT_SNAPSHOT_ROTATION,
  PHASE4_MAX_LOOKUPS,
  resolveCallPlan,
  formatCallPlan,
  budgetShortfall,
  countQueryGroups,
} from "./call-budget.js";

const PHASE1 = 215;
const PHASE2 = 117;

function plan(overrides = {}) {
  return resolveCallPlan({
    phase1Calls: PHASE1,
    phase2Calls: PHASE2,
    ...overrides,
  });
}

test("unset budget keeps the historical snapshot tiers", () => {
  const p = plan({ discoverLimitRaw: "150" });
  assert.equal(p.hot, DEFAULT_SNAPSHOT_HOT);
  assert.equal(p.rotation, DEFAULT_SNAPSHOT_ROTATION);
  assert.equal(p.scaled, false);
  assert.equal(p.budget, null);
  assert.equal(p.discoverCalls, 450);
  assert.equal(
    p.total,
    PHASE1 + PHASE2 + PHASE4_MAX_LOOKUPS + 6000 + 450,
  );
});

test("blank budget and blank tier pins are the same as unset", () => {
  const p = plan({
    budgetRaw: "  ",
    hotRaw: "",
    rotationRaw: "",
    trackedRaw: "",
    discoverLimitRaw: "",
  });
  assert.equal(p.hot, 1500);
  assert.equal(p.rotation, 4500);
  assert.equal(p.discoverCalls, 0);
  assert.equal(p.total, PHASE1 + PHASE2 + PHASE4_MAX_LOOKUPS + 6000);
});

test("DAILY_CALL_BUDGET=3000 shrinks snapshots and keeps the hot:rotation ratio", () => {
  const p = plan({ budgetRaw: "3000", discoverLimitRaw: "150" });
  const overhead = PHASE1 + PHASE2 + PHASE4_MAX_LOOKUPS + 450;
  assert.equal(p.scaled, true);
  assert.equal(p.snapshotCalls, 3000 - overhead);
  assert.equal(p.hot + p.rotation, p.snapshotCalls);
  assert.equal(p.total, 3000);
  // 1500:4500 is 1:3, so a quarter of the snapshot room is hot.
  assert.equal(p.hot, Math.round(p.snapshotCalls * 0.25));
});

test("a budget above the default does not grow the tiers", () => {
  const p = plan({ budgetRaw: "50000", discoverLimitRaw: "150" });
  assert.equal(p.scaled, false);
  assert.equal(p.hot, 1500);
  assert.equal(p.rotation, 4500);
  assert.ok(p.total < 50000);
});

test("explicit tier pins under the budget are kept", () => {
  const p = plan({ hotRaw: "100", rotationRaw: "200", budgetRaw: "10000" });
  assert.equal(p.hot, 100);
  assert.equal(p.rotation, 200);
  assert.equal(p.scaled, false);
  assert.equal(p.snapshotCalls, 300);
});

test("explicit tier pins over the budget are scaled down", () => {
  const p = plan({
    hotRaw: "1500",
    rotationRaw: "4500",
    budgetRaw: "3000",
    discoverLimitRaw: "150",
  });
  assert.equal(p.scaled, true);
  assert.equal(p.total, 3000);
});

test("SNAPSHOT_TRACKED_LIMIT is the fetch count, and the budget lowers it", () => {
  const uncapped = plan({ trackedRaw: "1000" });
  assert.equal(uncapped.snapshotCalls, 1000);
  assert.equal(uncapped.scaled, false);

  const capped = plan({ trackedRaw: "6000", budgetRaw: "2000", discoverLimitRaw: "150" });
  const overhead = PHASE1 + PHASE2 + PHASE4_MAX_LOOKUPS + 450;
  assert.equal(capped.tracked, 2000 - overhead);
  assert.equal(capped.snapshotCalls, capped.tracked);
  assert.equal(capped.total, 2000);
});

test("a non-numeric budget throws instead of spending the default", () => {
  assert.throws(() => plan({ budgetRaw: "3,000" }), /DAILY_CALL_BUDGET/);
  assert.throws(() => plan({ budgetRaw: "3k" }), /DAILY_CALL_BUDGET/);
});

test("zero budget is a real ceiling, not the default", () => {
  const p = plan({ budgetRaw: "0" });
  assert.equal(p.budget, 0);
  assert.equal(p.snapshotCalls, 0);
  assert.equal(p.total, PHASE1 + PHASE2 + PHASE4_MAX_LOOKUPS);
  assert.match(budgetShortfall(p), /PREFLIGHT STOP/);
  assert.match(budgetShortfall(p), /already at 0/);
});

test("a budget that fits has no shortfall", () => {
  assert.equal(budgetShortfall(plan({ discoverLimitRaw: "150" })), null);
  assert.equal(budgetShortfall(plan({ budgetRaw: "3000", discoverLimitRaw: "150" })), null);
});

test("the scaled plan warns that the rotation cycle gets longer", () => {
  const text = formatCallPlan(plan({ budgetRaw: "3000", discoverLimitRaw: "150" }));
  assert.match(text, /DAILY_CALL_BUDGET=3,000/);
  assert.match(text, /BUDGET WARNING/);
  assert.match(text, /10\.5 days/);
});

test("countQueryGroups sums the lists and ignores anything else", () => {
  assert.equal(countQueryGroups({ a: ["x", "y"], b: ["z"], c: "nope" }), 3);
});
