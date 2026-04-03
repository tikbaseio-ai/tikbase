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

      const customers = await stripe.customers.list({ email, limit: 100 });
      if (customers.data.length === 0) {
        return res.status(404).json({ error: "No subscription found for this email" });
      }

      // Find the customer that has an active subscription
      let customerId = customers.data[0].id;
      for (const customer of customers.data) {
        const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
        if (subs.data.length > 0) { customerId = customer.id; break; }
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
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

      // Get ALL customers for this email (Stripe can create duplicates)
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
  });

  return httpServer;
}
