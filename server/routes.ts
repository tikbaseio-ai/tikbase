import type { Express, Request } from "express";
import { type Server } from "http";
import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---- Supabase admin client (service role, server-only) ----
let cachedAdmin: SupabaseClient | null = null;
function getSupabaseAdmin(): SupabaseClient {
  if (cachedAdmin) return cachedAdmin;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  cachedAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdmin;
}

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
const isPaidStatus = (s: string | null | undefined) =>
  !!s && ACTIVE_STATUSES.has(s);

interface StoredSubscription {
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

function snapshot(sub: Stripe.Subscription): StoredSubscription {
  // current_period_end moved to the item level in recent Stripe API versions.
  const item = sub.items.data[0];
  const cpe =
    (item as any)?.current_period_end ??
    (sub as any).current_period_end ??
    null;
  return {
    status: sub.status,
    stripe_customer_id:
      typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    price_id: item?.price?.id ?? null,
    current_period_end: cpe ? new Date(cpe * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };
}

async function writeToUser(
  userId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: userData, error: getErr } =
    await supabase.auth.admin.getUserById(userId);
  if (getErr || !userData.user) {
    throw new Error(`User ${userId} not found: ${getErr?.message}`);
  }
  const prev = (userData.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prev, subscription: snapshot(sub) },
  });
  if (updErr) {
    throw new Error(
      `Failed to update user ${userId} app_metadata: ${updErr.message}`,
    );
  }
}

async function upsertSubscriptionForUser(
  stripe: Stripe,
  userId: string,
  subscriptionId: string,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await writeToUser(userId, sub);

  await Promise.all([
    stripe.subscriptions
      .update(sub.id, {
        metadata: { ...(sub.metadata || {}), supabase_user_id: userId },
      })
      .catch(() => {}),
    (async () => {
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;
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

async function syncSubscriptionById(
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

async function getStoredSubscription(
  userId: string,
): Promise<StoredSubscription | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const meta = (data.user.app_metadata as Record<string, any>) || {};
  return (meta.subscription as StoredSubscription | undefined) ?? null;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ---- Top videos (server-side computation with caching) ----
  const videoCache = new Map<string, { videos: any[]; timestamp: number }>();
  const VIDEO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  function extractPostDateServer(videoUrl: string): Date | null {
    const match = videoUrl?.match(/video\/(\d+)/);
    if (!match) return null;
    try {
      const ts = Number(BigInt(match[1]) >> 32n);
      const date = new Date(ts * 1000);
      if (date.getFullYear() < 2020 || date.getFullYear() > 2027) return null;
      return date;
    } catch { return null; }
  }

  app.get("/api/top-videos", async (req, res) => {
    try {
      const nicheSlug = (req.query.niche as string) || "all";
      const days = parseInt((req.query.days as string) || "7", 10);
      const page = parseInt((req.query.page as string) || "1", 10);
      const limit = parseInt((req.query.limit as string) || "50", 10);

      if (![7, 14, 30, 90, 180, 365].includes(days)) {
        return res.status(400).json({ error: "Invalid days" });
      }

      const cacheKey = `${nicheSlug}:${days}`;
      const cached = videoCache.get(cacheKey);
      let videos: any[];

      if (cached && Date.now() - cached.timestamp < VIDEO_CACHE_TTL) {
        videos = cached.videos;
      } else {
        const supabase = getSupabaseAdmin();
        const cutoffDate = new Date(Date.now() - days * 86400000);

        // Fetch all videos
        let allVids: any[] = [];
        if (nicheSlug === "all") {
          let offset = 0;
          while (true) {
            const { data } = await supabase.from("product_videos").select("*")
              .order("view_count", { ascending: false }).range(offset, offset + 999);
            if (!data || data.length === 0) break;
            allVids = allVids.concat(data);
            if (data.length < 1000) break;
            offset += 1000;
          }
        } else {
          let pids: string[] = [];
          let pOff = 0;
          while (true) {
            const { data } = await supabase.from("products").select("product_id")
              .eq("niche_slug", nicheSlug).gt("sold_count", 0).range(pOff, pOff + 999);
            if (!data || data.length === 0) break;
            pids = pids.concat(data.map((p: any) => p.product_id));
            if (data.length < 1000) break;
            pOff += 1000;
          }
          for (let i = 0; i < pids.length; i += 200) {
            const batch = pids.slice(i, i + 200);
            const { data } = await supabase.from("product_videos").select("*")
              .in("product_id", batch).order("view_count", { ascending: false }).limit(5000);
            if (data) allVids = allVids.concat(data);
          }
        }

        // Dedup + snowflake filter
        const seen = new Set<string>();
        const filtered = allVids
          .filter((v: any) => {
            const id = v.video_url?.match(/video\/(\d+)/)?.[1];
            if (!id || seen.has(id)) return false;
            seen.add(id);
            const pd = extractPostDateServer(v.video_url);
            return pd && pd >= cutoffDate;
          })
          .sort((a: any, b: any) => (b.view_count || 0) - (a.view_count || 0));

        // Fetch products
        const vpids = [...new Set(filtered.map((v: any) => v.product_id))] as string[];
        const pMap: Record<string, any> = {};
        for (let i = 0; i < vpids.length; i += 200) {
          const batch = vpids.slice(i, i + 200);
          const { data } = await supabase.from("products").select("*").in("product_id", batch);
          if (data) data.forEach((p: any) => { pMap[p.product_id] = p; });
        }

        videos = filtered
          .map((v: any) => {
            const p = pMap[v.product_id];
            if (!p || p.title?.includes("Discovered Videos") || (p.sold_count ?? 0) <= 0) return null;
            return { ...v, product: p };
          })
          .filter(Boolean) as any[];

        videoCache.set(cacheKey, { videos, timestamp: Date.now() });
      }

      const offset = (page - 1) * limit;
      res.setHeader("Cache-Control", "s-maxage=3600, max-age=300");
      return res.json({ videos: videos.slice(offset, offset + limit), total: videos.length, page, limit });
    } catch (err: any) {
      console.error("top-videos error:", err?.message);
      return res.status(500).json({ error: "Failed to fetch videos" });
    }
  });

  // ---- Stripe webhook: uses req.rawBody (captured by express.json verify in server/index.ts) ----
  app.post("/api/stripe-webhook", async (req: Request, res) => {
    const signature = req.headers["stripe-signature"] as string | undefined;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) {
      return res
        .status(400)
        .json({ error: "Missing signature or webhook secret" });
    }
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      return res.status(400).json({ error: "Missing raw body" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      console.error(
        "Stripe webhook signature verification failed:",
        err.message,
      );
      return res.status(400).json({ error: err.message });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId =
            session.client_reference_id ||
            session.metadata?.supabase_user_id ||
            null;
          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id;
          if (!userId || !subscriptionId) break;
          await upsertSubscriptionForUser(stripe, userId, subscriptionId);
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          if (!sub.metadata?.supabase_user_id) break;
          await syncSubscriptionById(stripe, sub.id);
          break;
        }
      }
      return res.json({ received: true });
    } catch (err: any) {
      console.error(`Webhook handler error (${event.type}):`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Create Stripe Checkout Session (replaces raw Payment Link URLs) ----
  app.post("/api/create-checkout-session", async (req, res) => {
    try {
      const { plan, user_id, email, promo_code } = req.body ?? {};
      const PRICE_IDS: Record<string, string> = {
        monthly: "price_1THHz2CmsZejQhLSRBkSjObx",
        annual: "price_1THHz3CmsZejQhLScuVuKg8o",
      };
      if (!plan || !PRICE_IDS[plan]) {
        return res.status(400).json({ error: "Invalid or missing plan" });
      }
      if (!user_id) {
        return res.status(400).json({ error: "user_id is required" });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const baseUrl = process.env.APP_URL || `${proto}://${host}`;

      // Resolve promo code (human-readable → Stripe promotion_code id)
      let promoArg: Partial<Stripe.Checkout.SessionCreateParams> = {
        allow_promotion_codes: true,
      };
      if (promo_code) {
        try {
          const list = await stripe.promotionCodes.list({
            code: promo_code,
            active: true,
            limit: 1,
          });
          if (list.data[0]) {
            promoArg = { discounts: [{ promotion_code: list.data[0].id }] };
          }
        } catch {
          /* fall through to allow_promotion_codes */
        }
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
        client_reference_id: user_id,
        metadata: { supabase_user_id: user_id },
        subscription_data: { metadata: { supabase_user_id: user_id } },
        ...(email ? { customer_email: email } : {}),
        success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}#/subscription-success`,
        cancel_url: `${baseUrl}/#/dashboard/plans`,
        ...promoArg,
      });

      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("create-checkout-session error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Verify checkout session (instant confirmation on success page) ----
  app.post("/api/verify-session", async (req, res) => {
    try {
      const { session_id, user_id } = req.body ?? {};
      if (!session_id || !user_id) {
        return res
          .status(400)
          .json({ error: "session_id and user_id are required" });
      }
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (
        session.client_reference_id &&
        session.client_reference_id !== user_id
      ) {
        return res
          .status(403)
          .json({ error: "Session does not belong to this user" });
      }
      if (session.payment_status !== "paid" && session.status !== "complete") {
        return res.json({ isPaid: false, status: session.status });
      }
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (!subscriptionId) {
        return res.json({
          isPaid: false,
          reason: "no_subscription_on_session",
        });
      }
      await upsertSubscriptionForUser(stripe, user_id, subscriptionId);
      return res.json({ isPaid: true });
    } catch (err: any) {
      console.error("verify-session error:", err.message);
      return res.status(500).json({ error: "Failed to verify session" });
    }
  });

  // ---- Check subscription by supabase user_id ----
  app.get("/api/check-subscription", async (req, res) => {
    try {
      const userId = req.query.user_id as string | undefined;
      if (!userId) return res.json({ isPaid: false });

      const sub = await getStoredSubscription(userId);
      return res.json({ isPaid: isPaidStatus(sub?.status) });
    } catch (err: any) {
      console.error("check-subscription exception:", err.message);
      return res.json({ isPaid: false });
    }
  });

  // ---- Billing portal (by supabase user_id) ----
  app.post("/api/create-portal-session", async (req, res) => {
    try {
      const { user_id } = req.body ?? {};
      if (!user_id)
        return res.status(400).json({ error: "user_id is required" });

      const stored = await getStoredSubscription(user_id);
      if (!stored) {
        return res
          .status(404)
          .json({ error: "No subscription found for this user" });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const session = await stripe.billingPortal.sessions.create({
        customer: stored.stripe_customer_id,
        return_url: "https://tikbase.io/#/dashboard/billing",
      });
      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("Portal session error:", err.message);
      return res.status(500).json({ error: "Failed to create portal session" });
    }
  });

  return httpServer;
}
