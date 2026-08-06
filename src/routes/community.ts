import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { rateLimiters } from "../middleware/rateLimiter";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { cache, withCache, TTL } from "../services/cacheStore";

export const communityRouter = Router();
communityRouter.use(requireAuth);

// GET /api/community/posts?page=1 — read-only, both plans, cached 5 min
communityRouter.get(
  "/posts",
  asyncHandler(async (req: AuthedRequest, res) => {
    const page = z.coerce.number().int().min(1).default(1).parse(req.query.page ?? 1);
    const pageSize = 20;

    const data = await withCache(`community:feed:page:${page}`, TTL.COMMUNITY_FEED_PAGE, async () => {
      const { rows } = await ccDb.query(
        `SELECT p.*, u.name AS author_name, u.plan AS author_plan
         FROM cc_community_posts p
         JOIN cc_users u ON u.id = p.user_id
         ORDER BY p.created_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, (page - 1) * pageSize]
      );
      return { posts: rows, page };
    });

    res.json(data);
  })
);

const createPostSchema = z.object({
  content: z.string().min(1).max(2000),
  post_type: z.enum(["update", "question", "resource", "founder-connect"]),
});

// POST /api/community/posts — Pro only (read is free, posting is Pro)
communityRouter.post(
  "/posts",
  rateLimiters.communityPost,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.ccUser!.plan !== "pro") {
      throw new ApiError(402, "Community posting is a Pro feature", {
        upgrade: { message: "Upgrade to Pro to post and connect with the founder.", upgrade_url: "/settings/billing" },
      });
    }
    const body = createPostSchema.parse(req.body);
    if (body.post_type === "founder-connect" && req.ccUser!.plan !== "pro") {
      throw new ApiError(402, "Founder Connect posts require Pro");
    }

    const { rows } = await ccDb.query(
      `INSERT INTO cc_community_posts (user_id, content, post_type) VALUES ($1,$2,$3) RETURNING *`,
      [req.ccUser!.id, body.content, body.post_type]
    );

    cache.deleteByPrefix("community:feed:page:"); // new post invalidates feed cache
    res.status(201).json({ post: rows[0] });
  })
);

// POST /api/community/posts/:id/like — toggle like atomically
communityRouter.post(
  "/posts/:id/like",
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = req.params.id;
    const userId = req.ccUser!.id;

    const client = await ccDb.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO cc_post_likes (post_id, user_id) VALUES ($1,$2)
         ON CONFLICT (post_id, user_id) DO NOTHING RETURNING id`,
        [postId, userId]
      );
      let liked: boolean;
      if (inserted.rows.length > 0) {
        await client.query(`UPDATE cc_community_posts SET likes_count = likes_count + 1 WHERE id = $1`, [postId]);
        liked = true;
      } else {
        await client.query(`DELETE FROM cc_post_likes WHERE post_id = $1 AND user_id = $2`, [postId, userId]);
        await client.query(`UPDATE cc_community_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1`, [postId]);
        liked = false;
      }
      await client.query("COMMIT");
      cache.deleteByPrefix("community:feed:page:");
      res.json({ liked });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);
