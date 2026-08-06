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

    let userRow = rows[0];

    if (!userRow) {
      // Auto-provision fallback: if Clerk verified the JWT but webhook hasn't arrived
      // or was misconfigured, provision the user row seamlessly on-the-fly.
      const email = (payload.email as string) || (payload.primary_email as string) || `${clerkId}@clerk.user`;
      const name = (payload.name as string) || null;
      const created = await ccDb.query(
        `INSERT INTO cc_users (clerk_id, email, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (clerk_id) DO UPDATE SET updated_at = now()
         RETURNING id, clerk_id, email, name, plan, apply_count, cover_letter_count, resume_count, profile_complete`,
        [clerkId, email, name]
      );
      userRow = created.rows[0];
      console.log(`[auth] auto-provisioned missing cc_users row for ${clerkId}`);
    }

    req.ccUser = userRow;
    next();
  } catch (err) {
    console.error("[auth] token verification failed:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
