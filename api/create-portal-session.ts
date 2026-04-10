import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Helpers inlined — see api/check-subscription.ts for context.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id } = (req.body ?? {}) as { user_id?: string };
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(500).json({ error: 'Supabase env vars missing' });
    }

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.admin.getUserById(user_id);
    if (error || !data.user) {
      return res.status(404).json({ error: 'No subscription found for this user' });
    }

    const stored = (data.user.app_metadata as any)?.subscription;
    if (!stored?.stripe_customer_id) {
      return res.status(404).json({ error: 'No subscription found for this user' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const session = await stripe.billingPortal.sessions.create({
      customer: stored.stripe_customer_id,
      return_url: 'https://tikbase.io/#/dashboard/billing',
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error('Portal session error:', err?.message);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
