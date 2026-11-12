/**
 * Ask ScrapeCreators what the key is worth before a refresh spends the day's
 * calls. The data endpoints answer HTTP 402 both for an empty balance and for
 * a rejected key ("Looks like you're out of credits" either way — that is why
 * the July and August runs could not tell a top-up from a bad secret). The
 * account balance endpoint is the one place the two come apart:
 *
 *   GET /v1/account/credit-balance
 *   200 { creditCount }   key accepted, this is the balance
 *   401 / 403             key rejected
 *   402 + "out of credits"  key accepted, balance empty
 *   402 + anything else   the vendor did not say which; we stop and quote it
 *
 * The published example also carries credits_remaining: 1000000, which is the
 * boilerplate pasted onto every endpoint sample. The description of this
 * endpoint says the balance is creditCount. Prefer that field.
 *
 * One probe. If the vendor charges it (the sample shows credits_charged: 1),
 * that is the whole cost of refusing to start a 6,000-call run.
 */

const BALANCE_URL = "https://api.scrapecreators.com/v1/account/credit-balance";

export function parseCreditBalance(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.creditCount === "number" && Number.isFinite(body.creditCount)) {
    return body.creditCount;
  }
  if (typeof body.credits_remaining === "number" && Number.isFinite(body.credits_remaining)) {
    return body.credits_remaining;
  }
  return null;
}

function bodyText(body, raw) {
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Classify a non-success from the balance endpoint.
 * @returns {'bad_key'|'out_of_credits'|'ambiguous'|'rejected'}
 */
export function classifyCreditFailure(status, body, raw) {
  const text = bodyText(body, raw).toLowerCase();
  const saysCredits = /out of credits|insufficient credits|no credits/.test(text);
  const saysKey = /invalid[^.]{0,40}key|api key|unauthori[sz]ed|forbidden|not valid/.test(text);

  if (status === 401 || status === 403) return "bad_key";
  if (saysKey && !saysCredits) return "bad_key";
  if (saysCredits) return "out_of_credits";
  if (status === 402) return "ambiguous";
  return "rejected";
}

export async function probeCredits(apiKey, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(BALANCE_URL, {
      headers: { "x-api-key": apiKey },
    });
  } catch (err) {
    return {
      ok: false,
      kind: "unreachable",
      message: err?.message || String(err),
    };
  }

  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  const quoted = bodyText(body, raw);

  if (!res.ok || (body && body.success === false)) {
    const kind = classifyCreditFailure(res.status, body, raw);
    return { ok: false, kind, status: res.status, quoted };
  }

  const balance = parseCreditBalance(body);
  if (balance === null) {
    return { ok: false, kind: "unreadable", status: res.status, quoted };
  }
  const charged =
    body && typeof body.credits_charged === "number" ? body.credits_charged : null;
  return { ok: true, kind: "ok", balance, charged, status: res.status };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {number} opts.need  credits this process (and, when included, the
 *   following discover step) will spend. The probe itself is already paid.
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function checkCredits({ apiKey, need, fetchImpl }) {
  if (process.env.SKIP_CREDIT_PREFLIGHT === "1") {
    return { ok: true, kind: "skipped", need };
  }
  if (!apiKey) {
    return { ok: false, kind: "missing_key", need };
  }
  const probe = await probeCredits(apiKey, fetchImpl);
  if (!probe.ok) return { ...probe, need };
  if (probe.balance <= 0) {
    return { ok: false, kind: "out_of_credits", balance: probe.balance, charged: probe.charged, need, status: probe.status };
  }
  if (probe.balance < need) {
    return { ok: false, kind: "short", balance: probe.balance, charged: probe.charged, need, status: probe.status };
  }
  return { ok: true, kind: "ok", balance: probe.balance, charged: probe.charged, need, status: probe.status };
}

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

export function formatPreflight(result, plan) {
  const needText = plan
    ? `up to ${fmt(plan.total)}`
    : `up to ${fmt(result.need ?? 0)}`;
  const charged =
    typeof result.charged === "number"
      ? `\nBalance probe reported credits_charged=${result.charged}.`
      : "";

  switch (result.kind) {
    case "skipped":
      return "PREFLIGHT SKIPPED: SKIP_CREDIT_PREFLIGHT=1. The credit balance was not checked.";
    case "missing_key":
      return (
        "PREFLIGHT STOP: SCRAPECREATORS_API_KEY is not set.\n" +
        "No ScrapeCreators calls were made."
      );
    case "bad_key":
      return (
        `PREFLIGHT STOP: ScrapeCreators rejected the API key (HTTP ${result.status}).\n` +
        "This is a bad or revoked key, not an empty balance.\n" +
        (result.quoted ? `Body: ${result.quoted}\n` : "") +
        "No data calls were made."
      );
    case "out_of_credits": {
      // A 200 with creditCount 0 means the key worked. A 402 whose body says
      // "out of credits" is the same fact from the error path. Either way it
      // is not a rejected key — that classification is `bad_key`.
      const lead =
        typeof result.balance === "number"
          ? `PREFLIGHT STOP: ScrapeCreators balance is ${fmt(result.balance)} credits.\n` +
            "The key is valid and the balance is empty. Top up, then re-run.\n"
          : `PREFLIGHT STOP: ScrapeCreators is out of credits (HTTP ${result.status}).\n` +
            "The body says the balance is empty, so the key was accepted. Top up, then re-run.\n";
      return (
        lead +
        (result.quoted ? `Body: ${result.quoted}\n` : "") +
        `This run needs ${needText}.\n` +
        "No data calls were made." +
        charged
      );
    }
    case "ambiguous":
      return (
        `PREFLIGHT STOP: ScrapeCreators returned HTTP ${result.status}.\n` +
        "This vendor uses 402 both when the balance is empty and when the key is rejected,\n" +
        "and the body did not say which.\n" +
        (result.quoted ? `Body: ${result.quoted}\n` : "") +
        "Check the key and the balance at https://scrapecreators.com before re-running.\n" +
        "No data calls were made."
      );
    case "unreachable":
      return (
        "PREFLIGHT STOP: could not read the ScrapeCreators credit balance.\n" +
        `Network error: ${result.message}\n` +
        "Refusing to spend calls without a balance. No data calls were made."
      );
    case "unreadable":
      return (
        `PREFLIGHT STOP: credit balance response had no creditCount (HTTP ${result.status}).\n` +
        (result.quoted ? `Body: ${result.quoted}\n` : "") +
        "Refusing to spend calls without a balance. No data calls were made."
      );
    case "short":
      return (
        `PREFLIGHT STOP: ScrapeCreators balance is ${fmt(result.balance)} credits.\n` +
        `This run needs ${needText}.\n` +
        "Top up, or set DAILY_CALL_BUDGET (repository variable or workflow input) to shrink the snapshot tiers.\n" +
        "No data calls were made." +
        charged
      );
    case "ok":
      return (
        `PREFLIGHT OK: ${fmt(result.balance)} credits remaining; this run needs ${needText}.` +
        charged
      );
    default:
      return (
        `PREFLIGHT STOP: credit check failed${result.status ? ` (HTTP ${result.status})` : ""}.\n` +
        (result.quoted ? `Body: ${result.quoted}\n` : "") +
        "No data calls were made."
      );
  }
}

export async function assertEnoughCredits(opts) {
  const result = await checkCredits(opts);
  const text = formatPreflight(result, opts.plan);
  if (!result.ok) {
    console.error("\n" + text + "\n");
    process.exit(1);
  }
  console.log("\n" + text + "\n");
  return result;
}
