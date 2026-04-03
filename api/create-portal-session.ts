import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const customers = await stripe.customers.list({ email, limit: 100 });

    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'No subscription found for this email' });
    }

    // Find the customer with an active subscription
    let customerId = customers.data[0].id;
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
      if (subs.data.length > 0) { customerId = customer.id; break; }
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://tikbase.io/#/billing',
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error('Portal session error:', err.message);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
