import type { VercelRequest, VercelResponse } from '@vercel/node';

// Temporary diagnostic version: no top-level imports of lib files, dynamic import
// wrapped in try/catch so we can see the real error instead of a generic Vercel crash page.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = req.query.user_id as string | undefined;
  if (!userId) return res.json({ isPaid: false });

  try {
    const { getStoredSubscription, isPaidStatus } = await import('../lib/supabaseAdmin');
    const sub = await getStoredSubscription(userId);
    return res.json({ isPaid: isPaidStatus(sub?.status) });
  } catch (err: any) {
    // Temporarily surface the real error so we can diagnose.
    return res.status(500).json({
      error: err?.message ?? String(err),
      stack: err?.stack?.split('\n').slice(0, 6),
      code: err?.code,
    });
  }
}
