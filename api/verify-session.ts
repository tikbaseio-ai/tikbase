// Success-page companion: retrieves the Stripe Checkout Session and upserts
// the subscription snapshot into auth.users.app_metadata.
// Helpers inlined — see api/check-subscription.ts for context.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

function snapshot(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  const cpe =
    (item as any)?.current_period_end ?? (sub as any).current_period_end ?? null;
  return {
    status: sub.status,
    stripe_customer_id:
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    price_id: item?.price?.id ?? null,
    current_period_end: cpe ? new Date(cpe * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };
}

async function writeSnapshot(
  supabase: any,
  userId: string,
  sub: Stripe.Subscription,
) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(`User ${userId} not found`);
  const prev = (data.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prev, subscription: snapshot(sub) },
  });
  if (updErr) throw new Error(`Failed to update user: ${updErr.message}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

    if (session.client_reference_id && session.client_reference_id !== user_id) {
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

    const sub = await stripe.subscriptions.retrieve(subscriptionId);

    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase env vars missing');
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await writeSnapshot(supabase, user_id, sub);

    // Also stamp supabase_user_id on Stripe side for future webhook traceability.
    await Promise.all([
      stripe.subscriptions
        .update(sub.id, {
          metadata: { ...(sub.metadata || {}), supabase_user_id: user_id },
        })
        .catch(() => {}),
      (async () => {
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        try {
          await stripe.customers.update(customerId, {
            metadata: { supabase_user_id: user_id },
          });
        } catch {
          /* non-fatal */
        }
      })(),
    ]);

    return res.json({ isPaid: true });
  } catch (err: any) {
    console.error('verify-session error:', err?.message);
    return res.status(500).json({ error: 'Failed to verify session' });
  }
}
