import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { syncSubscriptionById, upsertSubscriptionForUser } from '../lib/stripeSync';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        // client_reference_id is the supabase user id we passed when opening the payment link.
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
        if (!subscriptionId) {
          // One-time payments would land here — ignore.
          break;
        }
        await upsertSubscriptionForUser(stripe, userId, subscriptionId);
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        // We stamped supabase_user_id onto the subscription during the initial
        // upsert, so syncSubscriptionById can read it back.
        if (!sub.metadata?.supabase_user_id) {
          console.warn(
            `${event.type} for ${sub.id} has no supabase_user_id metadata — ignoring`,
          );
          break;
        }
        await syncSubscriptionById(stripe, sub.id);
        break;
      }

      default:
        // Ignore other events.
        break;
    }

    return res.json({ received: true });
  } catch (err: any) {
    console.error(`Error handling ${event.type}:`, err.message);
    // Return 500 so Stripe retries.
    return res.status(500).json({ error: err.message });
  }
}
