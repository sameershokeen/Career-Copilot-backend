import { Request, Response, NextFunction } from "express";
import { verifyToken } from "@clerk/backend";
import { env } from "../config/env";
import { ccDb } from "../config/db";

export interface AuthedRequest extends Request {
  clerkId?: string;
  ccUser?: {
    id: string;
    clerk_id: string;
    email: string;
    name: string | null;
    plan: "free" | "pro";
    apply_count: number;
    cover_letter_count: number;
    resume_count: number;
    profile_complete: boolean;
  };
}

/**
 * requireAuth — verifies the Clerk session JWT (Authorization: Bearer <token>),
 * then loads the matching cc_users row so downstream handlers get plan/counts
 * without a second lookup. 401s if the token is missing/invalid, or if no
 * cc_users row exists yet (should only happen in the brief window before the
 * Clerk webhook has created it — see routes/webhooks.clerk.ts).
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing bearer token" });
    }
    const token = header.slice("Bearer ".length);

    const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    const clerkId = payload.sub;
    if (!clerkId) return res.status(401).json({ error: "Invalid token" });

    req.clerkId = clerkId;

    const { rows } = await ccDb.query(
      `SELECT id, clerk_id, email, name, plan, apply_count, cover_letter_count,
              resume_count, profile_complete
       FROM cc_users WHERE clerk_id = $1`,
      [clerkId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: "User not provisioned yet",
        detail: "cc_users row not found — Clerk webhook may not have fired yet. Retry shortly.",
      });
    }

    req.ccUser = rows[0];
    next();
  } catch (err) {
    console.error("[auth] token verification failed:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
