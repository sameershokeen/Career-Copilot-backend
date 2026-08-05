import { Response, NextFunction } from "express";
import { AuthedRequest } from "./auth";
import { ccDb } from "../config/db";

interface Hit {
  timestamps: number[];
}

// key -> hits within the current window. Cleared lazily (expired timestamps
// filtered out on each check) — no separate sweep interval needed for a
// single-process backend.
const buckets = new Map<string, Hit>();

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** "user" keys by req.ccUser.id (falls back to IP if unauthenticated), "ip" always keys by IP */
  keyBy?: "user" | "ip";
  routeLabel: string; // for cc_rate_limit_logs.route
}

function getIp(req: AuthedRequest): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

export function rateLimit(opts: RateLimitOptions) {
  const { limit, windowMs, keyBy = "user", routeLabel } = opts;

  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const ip = getIp(req);
    const identity = keyBy === "user" ? req.ccUser?.id ?? `ip:${ip}` : `ip:${ip}`;
    const bucketKey = `${routeLabel}:${identity}`;

    const now = Date.now();
    const bucket = buckets.get(bucketKey) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0];
      const retryAfterSec = Math.ceil((windowMs - (now - oldest)) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));

      // Fire-and-forget log; don't block the 429 response on DB latency.
      ccDb
        .query(
          `INSERT INTO cc_rate_limit_logs (user_id, ip, route) VALUES ($1, $2, $3)`,
          [req.ccUser?.id ?? null, ip, routeLabel]
        )
        .catch((err) => console.error("[rateLimiter] failed to log hit:", err));

      return res.status(429).json({
        error: "Too Many Requests",
        route: routeLabel,
        limit,
        window_ms: windowMs,
        retry_after_seconds: retryAfterSec,
      });
    }

    bucket.timestamps.push(now);
    buckets.set(bucketKey, bucket);
    next();
  };
}

// Pre-configured limiters matching spec section 11's table.
export const rateLimiters = {
  aiRoutes: rateLimit({ limit: 20, windowMs: 60 * 60 * 1000, keyBy: "user", routeLabel: "ai" }),
  applyBulk: rateLimit({ limit: 5, windowMs: 60 * 60 * 1000, keyBy: "user", routeLabel: "apply_bulk" }),
  jobsList: rateLimit({ limit: 120, windowMs: 60 * 1000, keyBy: "user", routeLabel: "jobs_list" }),
  communityPost: rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, keyBy: "user", routeLabel: "community_post" }),
  authRoutes: rateLimit({ limit: 10, windowMs: 15 * 60 * 1000, keyBy: "ip", routeLabel: "auth" }),
  globalUnauth: rateLimit({ limit: 60, windowMs: 60 * 1000, keyBy: "ip", routeLabel: "global_unauth" }),
};
