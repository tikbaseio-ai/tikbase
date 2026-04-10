import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Vercel's @vercel/node builder doesn't bundle TS files outside api/ into the
// function bundle, so shared helpers are inlined here (and in the other api/*
// handlers). Kept small on purpose.

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const userId = req.query.user_id as string | undefined;
    if (!userId) return res.json({ isPaid: false });

    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return res.json({ isPaid: false });

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) return res.json({ isPaid: false });

    const sub = (data.user.app_metadata as any)?.subscription;
    const isPaid = !!sub?.status && ACTIVE_STATUSES.has(sub.status);
    return res.json({ isPaid });
  } catch (err: any) {
    console.error('check-subscription exception:', err?.message);
    return res.json({ isPaid: false });
  }
}
