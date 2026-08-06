import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { withCache, TTL } from "../services/cacheStore";

export const resourcesRouter = Router();
resourcesRouter.use(requireAuth);

const listQuerySchema = z.object({
  domain: z.enum(["frontend", "backend", "ai", "general"]).optional(),
  category: z.enum(["roadmap", "tip", "guide"]).optional(),
});

// GET /api/resources — cached 24h, invalidated via admin cache-clear endpoint
resourcesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);

    const all = await withCache("resources:all", TTL.RESOURCES_ALL, async () => {
      const { rows } = await ccDb.query(
        `SELECT * FROM cc_resources WHERE published = TRUE ORDER BY order_index ASC, created_at ASC`
      );
      return rows;
    });

    const filtered = all.filter(
      (r: any) => (!q.domain || r.domain === q.domain) && (!q.category || r.category === q.category)
    );
    res.json(filtered);
  })
);

resourcesRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const { rows } = await ccDb.query(`SELECT * FROM cc_resources WHERE slug = $1 AND published = TRUE`, [
      req.params.slug,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: "Resource not found" });
    res.json({ resource: rows[0] });
  })
);
