import { Router, raw } from "express";
import { Webhook } from "svix";
import { env } from "../config/env";
import { ccDb } from "../config/db";
import { asyncHandler } from "../middleware/errorHandler";

export const clerkWebhookRouter = Router();

// Clerk webhooks must receive the RAW body for signature verification —
// this route needs express.raw(), not express.json(). Mounted before the
// global json() middleware in index.ts.
clerkWebhookRouter.post(
  "/clerk",
  raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    let event: any;
    try {
      const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
      const headers = {
        "svix-id": req.headers["svix-id"] as string,
        "svix-timestamp": req.headers["svix-timestamp"] as string,
        "svix-signature": req.headers["svix-signature"] as string,
      };
      event = wh.verify(req.body, headers);
    } catch (err: any) {
      console.error("[webhooks/clerk] signature verification or secret initialization failed:", err?.message || err);
      return res.status(400).json({ error: "Invalid webhook signature or misconfigured CLERK_WEBHOOK_SECRET", details: err?.message });
    }

    if (event.type === "user.created") {
      const { id, email_addresses, first_name, last_name } = event.data;
      const email = email_addresses?.[0]?.email_address ?? "";
      const name = [first_name, last_name].filter(Boolean).join(" ") || null;

      await ccDb.query(
        `INSERT INTO cc_users (clerk_id, email, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_id) DO NOTHING`,
        [id, email, name]
      );
      console.log(`[webhooks/clerk] provisioned cc_users row for ${id}`);
    }

    // Other event types (user.updated, user.deleted, ...) can be handled
    // here later if needed — currently a no-op so Clerk still gets a 200.
    res.status(200).json({ received: true });
  })
);
