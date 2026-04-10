import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { getStoredSubscription } from '../lib/supabaseAdmin';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id } = req.body ?? {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const stored = await getStoredSubscription(user_id);
    if (!stored) {
      return res.status(404).json({ error: 'No subscription found for this user' });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const session = await stripe.billingPortal.sessions.create({
      customer: stored.stripe_customer_id,
      return_url: 'https://tikbase.io/#/dashboard/billing',
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error('Portal session error:', err.message);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
