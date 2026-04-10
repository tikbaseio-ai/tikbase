// Creates a Stripe Checkout Session for a subscription.
// This is the replacement for raw Payment Link URLs: everything that used to
// live in the Stripe Payment Link dashboard config (success URL, cancel URL,
// promo codes, client_reference_id) is now in code — one-time setup, no more
// dashboard clicks when adding new plans.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

// Hardcoded live Stripe price IDs. Add new plans here.
const PRICE_IDS: Record<string, string> = {
  monthly: 'price_1THHz2CmsZejQhLSRBkSjObx', // $44.99 / month
  annual: 'price_1THHz3CmsZejQhLScuVuKg8o', // $377.88 / year
};

/**
 * Look up a human-readable promo code and return either a `discounts` arg
 * with the resolved promotion_code id, or fall back to allow_promotion_codes
 * if the code doesn't exist (so the user can correct it on Stripe's page).
 */
async function resolvePromoCode(
  stripe: Stripe,
  code: string,
): Promise<Partial<Stripe.Checkout.SessionCreateParams>> {
  try {
    const list = await stripe.promotionCodes.list({
      code,
      active: true,
      limit: 1,
    });
    const found = list.data[0];
    if (found) return { discounts: [{ promotion_code: found.id }] };
  } catch {
    /* swallow — fall through */
  }
  return { allow_promotion_codes: true };
}

function getBaseUrl(req: VercelRequest): string {
  // Prefer explicit env, fall back to request host.
  if (process.env.APP_URL) return process.env.APP_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  return `${proto}://${host}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan, user_id, email, promo_code } = (req.body ?? {}) as {
      plan?: 'monthly' | 'annual';
      user_id?: string;
      email?: string;
      promo_code?: string;
    };

    if (!plan || !PRICE_IDS[plan]) {
      return res.status(400).json({ error: 'Invalid or missing plan' });
    }
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const baseUrl = getBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],

      // This is the critical bit: ties the checkout to the Supabase user.
      // The webhook reads this back off checkout.session.completed.
      client_reference_id: user_id,
      metadata: { supabase_user_id: user_id },
      subscription_data: {
        metadata: { supabase_user_id: user_id },
      },

      // Prefill but let the user change it — Stripe customer email is
      // decorative now; user_id is what matters.
      ...(email ? { customer_email: email } : {}),

      // Wouter hash routing: session_id lives in window.location.search
      // (before the `#`), which the success page reads on mount.
      success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}#/subscription-success`,
      cancel_url: `${baseUrl}/#/dashboard/plans`,

      // If the user typed a promo code in the paywall modal, look it up by its
      // human-readable code to get the promotion_code ID Stripe expects in `discounts`.
      // Fall back to allow_promotion_codes so they can enter one on Stripe's page.
      ...(promo_code
        ? await resolvePromoCode(stripe, promo_code)
        : { allow_promotion_codes: true }),
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error('create-checkout-session error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
}
