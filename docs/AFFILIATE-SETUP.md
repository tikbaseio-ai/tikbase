# Affiliate programme — the clicks a human has to do

The code side is done and vendor-neutral: a visit to `tikbase.io/?via=jane` is captured before the
router touches the URL, survives up to 30 days in `localStorage`, is written to
`user_metadata.referral` at signup, and comes back out of `/api/check-subscription` for the account
owner. Nothing in the repo calls a specific affiliate vendor, and nothing needs to.

What is **not** done, because it cannot be done from a terminal: creating the programme, connecting it
to the live Stripe account, and generating the promo code. That is this document.

Recommended vendor: **Rewardful** — it reads Stripe directly, so recurring commission is calculated
from real invoices rather than from anything we self-report, and its default link parameter is `via`,
which is the first one our capture checks.

---

## 1. Create the Rewardful account and connect Stripe

1. Sign up at <https://www.rewardful.com> and choose the plan that covers recurring commissions.
2. **Connect Stripe** when prompted. Authorise the **live** account — the same one carrying the
   existing subscriptions. Rewardful asks for read access to customers, subscriptions and invoices.
3. In Rewardful → **Settings → Company**, set the site URL to `https://tikbase.io`.

## 2. Set the commission: 50% recurring

Rewardful → **Programs → New program** (or edit the default):

| field | value |
|---|---|
| Name | TikBase Affiliates |
| Reward type | **Percentage** |
| Commission | **50%** |
| Recurring | **Yes — for the lifetime of the subscription** |
| Cookie duration | **30 days** (matches the 30-day TTL in `client/src/lib/referral.ts`; change both together) |
| Currency | USD |

At $44.99/month that is **$22.50 per referral per month**, for as long as the customer stays. Decide
before launching whether the annual plan ($31.49/mo billed yearly, $377.88) pays 50% of the first
invoice — Rewardful defaults to yes, which is **$188.94 in one go**. Cap it if that is not intended.

## 3. Create the first-month-free promo code in Stripe

This is a Stripe object, not a Rewardful one. Stripe Dashboard → **Products → Coupons**:

1. **New coupon** → Percentage discount **100%** → Duration **Once** (one billing period).
   Name it `AFFILIATE-FIRST-MONTH`.
2. On the coupon, **Create promotion code** → customer-facing code, e.g. `TIKBASE30`.
   Leave "limit to first-time customers" **on**.
3. Restrict it to the monthly price only if the intent is a free month rather than a free year.

The plans page already has a discount-code field (`data-testid="promo-code-input"`), and
`api/create-checkout-session.ts` passes it to Stripe Checkout, so a code created here works with no
code change.

**Watch the interaction:** a 100%-off first month means Stripe's first invoice is $0, and Rewardful
pays commission on collected revenue — so the affiliate earns nothing in month one and 50% from month
two. That is usually what you want. If affiliates should be paid on month one as well, switch the
coupon to a smaller percentage instead.

## 4. Point affiliates at the right link

Rewardful issues links as `https://tikbase.io/?via=<affiliate-id>`. Our capture also accepts
`ref`, `referral`, `aff` and `fpr`, so links from a different vendor keep working if you switch.

Sanity-check one before announcing the programme:

1. Open `https://tikbase.io/?via=test-code` in a private window.
2. In the console: `localStorage.getItem('tikbase.referral')` → should show `{"code":"test-code",…}`.
3. Sign up with a throwaway email.
4. `GET /api/check-subscription` with that user's token → the response carries
   `referral: { code: "test-code", … }`.

Steps 1–4 are exactly what the automated test in this PR does against a disposable user, so if it
passed there it will pass here — this is the manual version for after the vendor is connected.

## 5. What still needs deciding

- **Payouts.** Rewardful does not move money; it reports what is owed. PayPal Mass Pay and Wise are
  the usual choices. Nothing in the app is involved.
- **Self-referral.** Turn on Rewardful's "disallow self-referrals" so an affiliate cannot take 50%
  off their own subscription.
- **Terms.** A one-page affiliate agreement (cookie window, when commission is voided on refund,
  payout threshold). Rewardful ships a template.

## 6. If you pick a different vendor

The only assumption in the code is the query parameter, and five are already accepted. For a vendor
that uses something else, add it to `PARAMS` in `client/src/lib/referral.ts` — one line. Everything
downstream reads `user_metadata.referral.code` and does not care where it came from.
