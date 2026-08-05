import { Response, NextFunction } from "express";
import { AuthedRequest } from "./auth";

export type GatedFeature = "auto_apply" | "cover_letter" | "resume_create";

// Monthly limits (apply/cover_letter reset on the 1st via cron — see
// services/monthlyReset.ts). Resume limit is a running cap, not monthly.
const FREE_LIMITS: Record<GatedFeature, number> = {
  auto_apply: 10,
  cover_letter: 5,
  resume_create: 5,
};

const PRO_LIMITS: Record<GatedFeature, number> = {
  auto_apply: Infinity,
  cover_letter: Infinity,
  resume_create: 30,
};

const COUNT_COLUMN: Record<GatedFeature, "apply_count" | "cover_letter_count" | "resume_count"> = {
  auto_apply: "apply_count",
  cover_letter: "cover_letter_count",
  resume_create: "resume_count",
};

/**
 * planGate(feature) — must run AFTER requireAuth (needs req.ccUser).
 * Checks the user's current count for `feature` against their plan's limit.
 * On limit exceeded: 402 Payment Required + upgrade prompt JSON.
 * Does NOT increment the count itself — callers increment atomically after
 * the gated action actually succeeds (see routes for UPDATE ... SET x = x+1).
 */
export function planGate(feature: GatedFeature) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const user = req.ccUser;
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const limits = user.plan === "pro" ? PRO_LIMITS : FREE_LIMITS;
    const limit = limits[feature];
    const current = user[COUNT_COLUMN[feature]];

    if (current >= limit) {
      return res.status(402).json({
        error: "Plan limit reached",
        feature,
        plan: user.plan,
        limit,
        current,
        upgrade: {
          message: `You've hit the ${user.plan} plan limit for ${feature.replace("_", " ")}.`,
          cta: "Upgrade to Pro for unlimited auto-apply and cover letters.",
          upgrade_url: "/settings/billing",
        },
      });
    }

    next();
  };
}

export { FREE_LIMITS, PRO_LIMITS, COUNT_COLUMN };
