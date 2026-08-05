import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { asyncHandler, ApiError } from "../middleware/errorHandler";

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

function requirePro(req: AuthedRequest) {
  if (req.ccUser!.plan !== "pro") {
    throw new ApiError(402, "Job alerts are a Pro feature", {
      upgrade: { message: "Upgrade to Pro for email + SMS job alerts.", upgrade_url: "/settings/billing" },
    });
  }
}

alertsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rows } = await ccDb.query(`SELECT * FROM cc_alerts WHERE user_id = $1 ORDER BY created_at DESC`, [
      req.ccUser!.id,
    ]);
    res.json({ alerts: rows });
  })
);

const createAlertSchema = z.object({
  keywords: z.array(z.string()).default([]),
  location: z.string().optional(),
  role_type: z.string().optional(),
  frequency: z.enum(["instant", "daily", "weekly"]).default("daily"),
  channel: z.enum(["email", "sms", "both"]).default("email"),
});

// POST /api/alerts — Pro only, per spec section 10 (Free: no alerts)
alertsRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    requirePro(req);
    const body = createAlertSchema.parse(req.body);
    const { rows } = await ccDb.query(
      `INSERT INTO cc_alerts (user_id, keywords, location, role_type, frequency, channel) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.ccUser!.id, body.keywords, body.location, body.role_type, body.frequency, body.channel]
    );
    res.status(201).json({ alert: rows[0] });
  })
);

alertsRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rowCount } = await ccDb.query(`DELETE FROM cc_alerts WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.ccUser!.id,
    ]);
    if (!rowCount) throw new ApiError(404, "Alert not found");
    res.json({ success: true });
  })
);
