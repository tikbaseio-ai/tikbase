import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStoredSubscription, isPaidStatus } from '../lib/supabaseAdmin';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const userId = req.query.user_id as string | undefined;
    if (!userId) return res.json({ isPaid: false });

    const sub = await getStoredSubscription(userId);
    return res.json({ isPaid: isPaidStatus(sub?.status) });
  } catch (err: any) {
    console.error('check-subscription exception:', err.message);
    return res.json({ isPaid: false });
  }
}
