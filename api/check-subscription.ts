import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const email = req.query.email as string;
    if (!email) return res.json({ isPaid: false });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Get ALL customers for this email (Stripe creates duplicates per checkout)
    const customers = await stripe.customers.list({ email, limit: 100 });
    if (customers.data.length === 0) return res.json({ isPaid: false });

    // Check every customer for an active subscription
    for (const customer of customers.data) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 1,
      });
      if (subscriptions.data.length > 0) {
        return res.json({ isPaid: true });
      }
    }

    return res.json({ isPaid: false });
  } catch (err) {
    return res.json({ isPaid: false });
  }
}
