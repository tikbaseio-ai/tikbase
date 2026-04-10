// Called by the success page for instant subscription confirmation.
// Retrieves the Stripe Checkout Session (always up-to-date) and upserts the
// mapping into user_subscriptions, so the user isn't dependent on webhook latency.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { upsertSubscriptionForUser } from './_lib/stripeSync';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { session_id, user_id } = (req.body ?? {}) as {
      session_id?: string;
      user_id?: string;
    };
    if (!session_id || !user_id) {
      return res.status(400).json({ error: 'session_id and user_id are required' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Defence in depth: the client_reference_id on the session must match
    // the user_id the caller claims. This prevents a logged-in user from
    // claiming someone else's checkout session.
    if (
      session.client_reference_id &&
      session.client_reference_id !== user_id
    ) {
      return res.status(403).json({ error: 'Session does not belong to this user' });
    }

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.json({ isPaid: false, status: session.status });
    }

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;

    if (!subscriptionId) {
      return res.json({ isPaid: false, reason: 'no_subscription_on_session' });
    }

    await upsertSubscriptionForUser(stripe, user_id, subscriptionId);

    return res.json({ isPaid: true });
  } catch (err: any) {
    console.error('verify-session error:', err.message);
    return res.status(500).json({ error: 'Failed to verify session' });
  }
}
