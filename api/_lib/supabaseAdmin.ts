// Server-only Supabase client using the service-role key.
// NEVER import this from client code — it bypasses RLS and has admin access.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

// Statuses we treat as "paid / has access".
export const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function isPaidStatus(status: string | null | undefined): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}

export interface StoredSubscription {
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

/** Read the stored subscription snapshot off a user's app_metadata. */
export async function getStoredSubscription(
  userId: string,
): Promise<StoredSubscription | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const meta = (data.user.app_metadata as Record<string, any>) || {};
  return (meta.subscription as StoredSubscription | undefined) ?? null;
}
