import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { planGate } from "../middleware/planGate";
import { asyncHandler } from "../middleware/errorHandler";
import { ApiError } from "../middleware/errorHandler";
import { aiClient } from "../services/aiClient";

export const resumesRouter = Router();
resumesRouter.use(requireAuth);

const resumeContentSchema = z.object({
  personal_info: z.record(z.string(), z.any()).optional(),
  social_links: z.record(z.string(), z.any()).optional(),
  summary: z.string().optional(),
  experience: z.array(z.record(z.string(), z.any())).optional(),
  projects: z.array(z.record(z.string(), z.any())).optional(),
  education: z.array(z.record(z.string(), z.any())).optional(),
  skills: z.record(z.string(), z.any()).optional(),
  certifications: z.array(z.record(z.string(), z.any())).optional(),
  publications: z.array(z.record(z.string(), z.any())).optional(),
});

// GET /api/resumes — list
resumesRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rows } = await ccDb.query(
      `SELECT * FROM cc_resumes WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.ccUser!.id]
    );
    res.json({ resumes: rows });
  })
);

// GET /api/resumes/:id
resumesRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rows } = await ccDb.query(
      `SELECT * FROM cc_resumes WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.ccUser!.id]
    );
    if (rows.length === 0) throw new ApiError(404, "Resume not found");
    res.json({ resume: rows[0] });
  })
);

const createResumeSchema = z.object({
  name: z.string().min(1),
  content: resumeContentSchema,
  is_default: z.boolean().optional(),
});

// POST /api/resumes — create, gated by resume_create limit (free: 5, pro: 30)
resumesRouter.post(
  "/",
  planGate("resume_create"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = createResumeSchema.parse(req.body);
    const userId = req.ccUser!.id;

    const client = await ccDb.connect();
    try {
      await client.query("BEGIN");
      if (body.is_default) {
        await client.query(`UPDATE cc_resumes SET is_default = FALSE WHERE user_id = $1`, [userId]);
      }
      const { rows } = await client.query(
        `INSERT INTO cc_resumes (user_id, name, content, is_default) VALUES ($1,$2,$3,$4) RETURNING *`,
        [userId, body.name, body.content, body.is_default ?? false]
      );
      await client.query(
        `UPDATE cc_users SET resume_count = resume_count + 1, updated_at = now() WHERE id = $1`,
        [userId]
      );
      await client.query("COMMIT");
      res.status(201).json({ resume: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

const updateResumeSchema = z.object({
  name: z.string().min(1).optional(),
  content: resumeContentSchema.optional(),
  is_default: z.boolean().optional(),
});

// PUT /api/resumes/:id — update (every builder save persists here per spec)
resumesRouter.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = updateResumeSchema.parse(req.body);
    const userId = req.ccUser!.id;

    const client = await ccDb.connect();
    try {
      await client.query("BEGIN");
      if (body.is_default) {
        await client.query(`UPDATE cc_resumes SET is_default = FALSE WHERE user_id = $1`, [userId]);
      }
      const { rows } = await client.query(
        `UPDATE cc_resumes SET
           name = COALESCE($1, name),
           content = COALESCE($2, content),
           is_default = COALESCE($3, is_default),
           updated_at = now()
         WHERE id = $4 AND user_id = $5
         RETURNING *`,
        [body.name, body.content, body.is_default, req.params.id, userId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new ApiError(404, "Resume not found");
      }
      await client.query("COMMIT");
      res.json({ resume: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

// POST /api/resumes/:id/parse — run the builder's structured content through
// the AI resume parser, producing the canonical cc_parsed_resumes record that
// match-scoring and cover-letter generation read from. Frontend contract:
// lib/api.ts's parseResume(resumeId) calls this with no body.
resumesRouter.post(
  "/:id/parse",
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.ccUser!.id;
    const { rows } = await ccDb.query(
      `SELECT * FROM cc_resumes WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId]
    );
    if (rows.length === 0) throw new ApiError(404, "Resume not found");

    const parsed = await aiClient.parseResume({
      rawText: JSON.stringify(rows[0].content),
      resumeId: rows[0].id,
    });

    await ccDb.query(
      `INSERT INTO cc_parsed_resumes (user_id, resume_id, parsed_data) VALUES ($1,$2,$3)`,
      [userId, rows[0].id, parsed]
    );

    res.status(201).json({ parsed: true });
  })
);

// DELETE /api/resumes/:id
resumesRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.ccUser!.id;
    const client = await ccDb.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `DELETE FROM cc_resumes WHERE id = $1 AND user_id = $2`,
        [req.params.id, userId]
      );
      if (rowCount && rowCount > 0) {
        await client.query(
          `UPDATE cc_users SET resume_count = GREATEST(resume_count - 1, 0), updated_at = now() WHERE id = $1`,
          [userId]
        );
      }
      if (!rowCount) {
        await client.query("ROLLBACK");
        throw new ApiError(404, "Resume not found");
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);
