import type { Express } from "express";
import { createServer, type Server } from "http";
import Stripe from "stripe";
import { storage } from "./storage";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // prefix all routes with /api
  // use storage to perform CRUD operations on the storage interface
  // e.g. app.get("/api/items", async (_req, res) => { ... })

  app.post("/api/create-portal-session", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

      const customers = await stripe.customers.list({ email, limit: 1 });
      if (customers.data.length === 0) {
        return res.status(404).json({ error: "No subscription found for this email" });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customers.data[0].id,
        return_url: "https://tikbase.io/#/billing",
      });

      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("Portal session error:", err.message);
      return res.status(500).json({ error: "Failed to create portal session" });
    }
  });

  app.get("/api/check-subscription", async (req, res) => {
    try {
      const email = req.query.email as string;
      if (!email) return res.json({ isPaid: false });

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const customers = await stripe.customers.list({ email, limit: 1 });

      if (customers.data.length === 0) return res.json({ isPaid: false });

      const subscriptions = await stripe.subscriptions.list({
        customer: customers.data[0].id,
        status: 'active',
        limit: 1,
      });

      return res.json({ isPaid: subscriptions.data.length > 0 });
    } catch (err) {
      return res.json({ isPaid: false });
    }
  });

  return httpServer;
}
