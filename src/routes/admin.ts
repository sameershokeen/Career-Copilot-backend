import { Router, Response, NextFunction, Request } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { ccDb } from "../config/db";
import { cache } from "../services/cacheStore";
import { asyncHandler } from "../middleware/errorHandler";
import { resetMonthlyCounts } from "../services/monthlyReset";

export const adminRouter = Router();

function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-admin-key"];
  if (key !== env.ADMIN_API_KEY) return res.status(401).json({ error: "Invalid admin key" });
  next();
}
adminRouter.use(requireAdminKey);

// POST /api/admin/cache/clear — clears everything, or just a prefix (?prefix=jobs:)
adminRouter.post(
  "/cache/clear",
  asyncHandler(async (req, res) => {
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
    if (prefix) {
      cache.deleteByPrefix(prefix);
    } else {
      cache.clearAll();
    }
    res.json({ success: true, cleared: prefix ?? "all" });
  })
);

const resourceSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(["roadmap", "tip", "guide"]),
  domain: z.enum(["frontend", "backend", "ai", "general"]),
  content: z.string().min(1),
  order_index: z.number().int().default(0),
  published: z.boolean().default(true),
});

// POST /api/admin/resources — upsert a resource (roadmap/tip/guide), no redeploy needed
adminRouter.post(
  "/resources",
  asyncHandler(async (req, res) => {
    const body = resourceSchema.parse(req.body);
    const { rows } = await ccDb.query(
      `INSERT INTO cc_resources (slug, title, category, domain, content, order_index, published)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, category = EXCLUDED.category, domain = EXCLUDED.domain,
         content = EXCLUDED.content, order_index = EXCLUDED.order_index, published = EXCLUDED.published,
         updated_at = now()
       RETURNING *`,
      [body.slug, body.title, body.category, body.domain, body.content, body.order_index, body.published]
    );
    cache.delete("resources:all");
    res.status(201).json({ resource: rows[0] });
  })
);

// POST /api/admin/reset-monthly — manual trigger for monthly quota reset
adminRouter.post(
  "/reset-monthly",
  asyncHandler(async (req, res) => {
    const resetCount = await resetMonthlyCounts();
    res.json({ success: true, reset_users: resetCount });
  })
);
