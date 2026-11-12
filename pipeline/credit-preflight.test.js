/**
 * The balance probe has to tell a dead key from an empty wallet before any
 * product call goes out. The data endpoints cannot: both come back as 402.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCreditBalance,
  classifyCreditFailure,
  checkCredits,
  formatPreflight,
} from "./credit-preflight.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("creditCount wins over the boilerplate credits_remaining", () => {
  // The published sample pairs creditCount: 333 with credits_remaining: 1000000.
  // The endpoint description says the balance is creditCount.
  assert.equal(
    parseCreditBalance({ success: true, credits_remaining: 1000000, credits_charged: 1, creditCount: 333 }),
    333,
  );
});

test("credits_remaining is the fallback when creditCount is absent", () => {
  assert.equal(parseCreditBalance({ credits_remaining: 40 }), 40);
  assert.equal(parseCreditBalance({}), null);
  assert.equal(parseCreditBalance(null), null);
});

test("401 is a bad key, and a 402 that says so is too", () => {
  assert.equal(classifyCreditFailure(401, { message: "Unauthorized" }, ""), "bad_key");
  assert.equal(classifyCreditFailure(403, {}, ""), "bad_key");
  assert.equal(
    classifyCreditFailure(402, { message: "Invalid API key" }, ""),
    "bad_key",
  );
});

test("402 out of credits is not a bad key", () => {
  assert.equal(
    classifyCreditFailure(402, { message: "Looks like you're out of credits" }, ""),
    "out_of_credits",
  );
});

test("a bare 402 stays ambiguous — that is the vendor's collision", () => {
  assert.equal(classifyCreditFailure(402, {}, ""), "ambiguous");
  assert.equal(classifyCreditFailure(402, { message: "Payment required" }, ""), "ambiguous");
});

test("a valid key with too few credits stops the run", async () => {
  const result = await checkCredits({
    apiKey: "test-key",
    need: 6982,
    fetchImpl: async () => jsonResponse(200, { success: true, creditCount: 1200, credits_charged: 1 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "short");
  const text = formatPreflight(result, { total: 6982 });
  assert.match(text, /PREFLIGHT STOP/);
  assert.match(text, /1,200 credits/);
  assert.match(text, /6,982/);
  assert.match(text, /DAILY_CALL_BUDGET/);
  assert.match(text, /No data calls were made/);
});

test("a zero balance is out of credits, and the key is valid", async () => {
  const result = await checkCredits({
    apiKey: "test-key",
    need: 100,
    fetchImpl: async () => jsonResponse(200, { success: true, creditCount: 0 }),
  });
  assert.equal(result.kind, "out_of_credits");
  const text = formatPreflight(result);
  assert.match(text, /balance is 0 credits/);
  assert.match(text, /key is valid/);
  assert.doesNotMatch(text, /rejected the API key/);
});

test("the out-of-credits error path is not reported as a bad key", async () => {
  const result = await checkCredits({
    apiKey: "test-key",
    need: 100,
    fetchImpl: async () => jsonResponse(402, { message: "Looks like you're out of credits" }),
  });
  assert.equal(result.kind, "out_of_credits");
  const text = formatPreflight(result);
  assert.match(text, /out of credits \(HTTP 402\)/);
  assert.match(text, /key was accepted/);
  assert.doesNotMatch(text, /rejected the API key/);
});

test("a rejected key is not reported as an empty balance", async () => {
  const result = await checkCredits({
    apiKey: "nope",
    need: 100,
    fetchImpl: async () => jsonResponse(401, { message: "Unauthorized" }),
  });
  assert.equal(result.kind, "bad_key");
  const text = formatPreflight(result);
  assert.match(text, /rejected the API key/);
  assert.match(text, /not an empty balance/);
  assert.doesNotMatch(text, /Top up/);
});

test("an ambiguous 402 quotes the body and names both possibilities", async () => {
  const result = await checkCredits({
    apiKey: "k",
    need: 10,
    fetchImpl: async () => jsonResponse(402, { message: "nope" }),
  });
  assert.equal(result.kind, "ambiguous");
  const text = formatPreflight(result);
  assert.match(text, /both when the balance is empty and when the key is rejected/);
  assert.match(text, /nope/);
});

test("enough credits proceeds and reports the balance", async () => {
  const result = await checkCredits({
    apiKey: "k",
    need: 6982,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.scrapecreators.com/v1/account/credit-balance");
      assert.equal(init.headers["x-api-key"], "k");
      return jsonResponse(200, { success: true, creditCount: 80000, credits_charged: 0 });
    },
  });
  assert.equal(result.ok, true);
  const text = formatPreflight(result, { total: 6982 });
  assert.match(text, /PREFLIGHT OK: 80,000 credits remaining/);
  assert.match(text, /credits_charged=0/);
});

test("a missing key never calls the vendor", async () => {
  let called = false;
  const result = await checkCredits({
    apiKey: "",
    need: 10,
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, { creditCount: 1 });
    },
  });
  assert.equal(called, false);
  assert.equal(result.kind, "missing_key");
  assert.match(formatPreflight(result), /SCRAPECREATORS_API_KEY is not set/);
});

test("a network failure refuses to spend", async () => {
  const result = await checkCredits({
    apiKey: "k",
    need: 10,
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  assert.equal(result.kind, "unreachable");
  assert.match(formatPreflight(result), /Refusing to spend calls/);
});

test("a 200 without a balance field refuses to spend", async () => {
  const result = await checkCredits({
    apiKey: "k",
    need: 10,
    fetchImpl: async () => jsonResponse(200, { success: true }),
  });
  assert.equal(result.kind, "unreadable");
});
