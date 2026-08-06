import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/errorHandler";
import { cache, withCache, TTL } from "../services/cacheStore";
import { FREE_LIMITS, PRO_LIMITS, formatLimits } from "../middleware/planGate";

export const userRouter = Router();
userRouter.use(requireAuth);

// GET /api/user/profile — profile + resume list
userRouter.get(
  "/profile",
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.ccUser!.id;
    const data = await withCache(`user:profile:${userId}`, TTL.USER_PROFILE, async () => {
      const [profileRes, resumesRes] = await Promise.all([
        ccDb.query(`SELECT * FROM cc_user_profiles WHERE user_id = $1`, [userId]),
        ccDb.query(
          `SELECT id, name, is_default, created_at, updated_at FROM cc_resumes WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        ),
      ]);
      return {
        user: req.ccUser,
        profile: profileRes.rows[0] ?? null,
        resumes: resumesRes.rows,
      };
    });
    res.json(data);
  })
);

const updateProfileSchema = z.object({
  phone: z.string().optional(),
  location: z.string().optional(),
  linkedin: z.string().url().optional().or(z.literal("")),
  github: z.string().url().optional().or(z.literal("")),
  portfolio: z.string().url().optional().or(z.literal("")),
  twitter: z.string().optional(),
  bio: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

// PUT /api/user/profile — update profile, invalidates cache
userRouter.put(
  "/profile",
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.ccUser!.id;
    const body = updateProfileSchema.parse(req.body);

    await ccDb.query(
      `INSERT INTO cc_user_profiles (user_id, phone, location, linkedin, github, portfolio, twitter, bio, skills, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (user_id) DO UPDATE SET
         phone = EXCLUDED.phone, location = EXCLUDED.location, linkedin = EXCLUDED.linkedin,
         github = EXCLUDED.github, portfolio = EXCLUDED.portfolio, twitter = EXCLUDED.twitter,
         bio = EXCLUDED.bio, skills = EXCLUDED.skills, updated_at = now()`,
      [userId, body.phone, body.location, body.linkedin, body.github, body.portfolio, body.twitter, body.bio, body.skills]
    );

    await ccDb.query(
      `UPDATE cc_users SET profile_complete = TRUE, updated_at = now() WHERE id = $1`,
      [userId]
    );

    cache.delete(`user:profile:${userId}`);
    res.json({ success: true });
  })
);

// GET /api/user/status — plan, counts, limits
userRouter.get(
  "/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = req.ccUser!;
    const limits = user.plan === "pro" ? PRO_LIMITS : FREE_LIMITS;
    res.json({
      plan: user.plan,
      counts: {
        apply_count: user.apply_count,
        cover_letter_count: user.cover_letter_count,
        resume_count: user.resume_count,
      },
      limits: formatLimits(limits),
      profile_complete: user.profile_complete,
    });
  })
);
