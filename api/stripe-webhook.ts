// Stripe webhook: checkout.session.completed + customer.subscription.updated/.deleted.
// Helpers inlined — see api/check-subscription.ts for context.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Stripe signature verification requires the raw request body.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

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

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function writeSnapshot(userId: string, sub: Stripe.Subscription) {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(`User ${userId} not found`);
  const prev = (data.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prev, subscription: snapshot(sub) },
  });
  if (updErr) throw new Error(`Failed to update user: ${updErr.message}`);
}

async function upsertForUser(
  stripe: Stripe,
  userId: string,
  subscriptionId: string,
) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await writeSnapshot(userId, sub);

  // Stamp supabase_user_id on Stripe customer + subscription for traceability.
  await Promise.all([
    stripe.subscriptions
      .update(sub.id, {
        metadata: { ...(sub.metadata || {}), supabase_user_id: userId },
      })
      .catch(() => {}),
    (async () => {
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      try {
        await stripe.customers.update(customerId, {
          metadata: { supabase_user_id: userId },
        });
      } catch {
        /* non-fatal */
      }
    })(),
  ]);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return res.status(400).json({ error: 'Missing signature or webhook secret' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const rawBody = await readRawBody(req);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId =
          session.client_reference_id ||
          (session.metadata && session.metadata.supabase_user_id) ||
          null;
        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (!userId) {
          console.error('checkout.session.completed missing client_reference_id', session.id);
          break;
        }
        if (!subscriptionId) break;
        await upsertForUser(stripe, userId, subscriptionId);
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) {
          console.warn(`${event.type} for ${sub.id} has no supabase_user_id metadata — ignoring`);
          break;
        }
        await writeSnapshot(userId, sub);
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err: any) {
    console.error(`Error handling ${event.type}:`, err?.message);
    return res.status(500).json({ error: err?.message });
  }
}
