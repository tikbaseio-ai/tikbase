// Writes the subscription snapshot into auth.users.app_metadata via the
// Supabase Admin API. Used by both the webhook and verify-session so the
// "instant" and "eventual" paths converge on the same payload shape.

import Stripe from 'stripe';
import { getSupabaseAdmin } from './supabaseAdmin';

export interface StoredSubscription {
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

function snapshot(sub: Stripe.Subscription): StoredSubscription {
  // In recent Stripe API versions, current_period_end is on the subscription
  // item, not the top-level subscription. Fall back to the top-level field
  // for older API versions / backward compatibility.
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

async function writeToUser(userId: string, sub: Stripe.Subscription): Promise<void> {
  const supabase = getSupabaseAdmin();
  // Fetch existing so we merge rather than clobber other app_metadata keys.
  const { data: userData, error: getErr } = await supabase.auth.admin.getUserById(userId);
  if (getErr || !userData.user) {
    throw new Error(`User ${userId} not found: ${getErr?.message}`);
  }
  const prev = (userData.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...prev,
      subscription: snapshot(sub),
    },
  });
  if (updErr) {
    throw new Error(`Failed to update user ${userId} app_metadata: ${updErr.message}`);
  }
}

/**
 * Upsert a subscription mapping keyed by supabase user_id.
 * Caller must provide the user_id — we don't try to infer it here.
 */
export async function upsertSubscriptionForUser(
  stripe: Stripe,
  userId: string,
  subscriptionId: string,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await writeToUser(userId, sub);

  // Also stamp the supabase user_id onto the Stripe customer & subscription
  // metadata so the link survives on the Stripe side too (useful for support
  // and for the .updated / .deleted webhook flow).
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

/**
 * Refresh the stored snapshot for a subscription we already know about.
 * Called from customer.subscription.updated / .deleted webhooks — we read
 * `supabase_user_id` off the subscription's metadata (stamped during upsert).
 */
export async function syncSubscriptionById(
  stripe: Stripe,
  subscriptionId: string,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) {
    throw new Error(
      `subscription ${sub.id} has no supabase_user_id metadata — cannot sync`,
    );
  }
  await writeToUser(userId, sub);
}
