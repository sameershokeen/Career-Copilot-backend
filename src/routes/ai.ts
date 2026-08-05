import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { planGate } from "../middleware/planGate";
import { rateLimiters } from "../middleware/rateLimiter";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { aiClient, ParsedResume } from "../services/aiClient";
import { getJobById } from "../services/jobsEnrich";
import { cache } from "../services/cacheStore";

export const aiRouter = Router();
aiRouter.use(requireAuth);
aiRouter.use(rateLimiters.aiRoutes);

const parseResumeSchema = z.object({
  resume_id: z.string().uuid().optional(),
  pdf_base64: z.string().optional(),
  raw_text: z.string().optional(),
}).refine((v) => v.pdf_base64 || v.raw_text, { message: "pdf_base64 or raw_text required" });

// POST /api/ai/parse-resume
aiRouter.post(
  "/parse-resume",
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseResumeSchema.parse(req.body);
    const parsed = await aiClient.parseResume({ pdfBase64: body.pdf_base64, rawText: body.raw_text, resumeId: body.resume_id });

    const { rows } = await ccDb.query(
      `INSERT INTO cc_parsed_resumes (user_id, resume_id, parsed_data) VALUES ($1,$2,$3) RETURNING *`,
      [req.ccUser!.id, body.resume_id ?? null, parsed]
    );
    res.status(201).json({ parsed_resume: rows[0] });
  })
);

// POST /api/ai/match/:jobId — "Compute Match" button, cached per (user, job), free for all plans
// (was POST /api/ai/match-score with job_id in the body — path changed to
// /match/:jobId to match the frontend's lib/api.ts contract: getMatchScore
// calls POST `/api/ai/match/${jobId}`.)
aiRouter.post(
  "/match/:jobId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const job_id = z.coerce.number().int().positive().parse(req.params.jobId);
    const userId = req.ccUser!.id;
    const cacheKey = `match:${userId}:${job_id}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json({ match_score: cached, cached: true });

    const job = await getJobById(job_id);
    if (!job) throw new ApiError(404, "Job not found");

    const { rows: parsedRows } = await ccDb.query(
      `SELECT parsed_data FROM cc_parsed_resumes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (parsedRows.length === 0) {
      throw new ApiError(400, "No parsed resume on file", { hint: "Call /api/ai/parse-resume first" });
    }
    const resume = parsedRows[0].parsed_data as ParsedResume;

    const score = await aiClient.scoreMatch({ job, resume });

    const { rows } = await ccDb.query(
      `INSERT INTO cc_match_scores (user_id, job_id, overall_score, skills_match, experience_match, domain_match, missing_skills, strengths, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, job_id) DO UPDATE SET
         overall_score = EXCLUDED.overall_score, skills_match = EXCLUDED.skills_match,
         experience_match = EXCLUDED.experience_match, domain_match = EXCLUDED.domain_match,
         missing_skills = EXCLUDED.missing_skills, strengths = EXCLUDED.strengths,
         summary = EXCLUDED.summary, computed_at = now()
       RETURNING *`,
      [userId, job_id, score.overall_score, score.skills_match, score.experience_match, score.domain_match, score.missing_skills, score.strengths, score.summary]
    );

    cache.set(cacheKey, rows[0], 60 * 60 * 1000);
    res.status(201).json({ match_score: rows[0] });
  })
);

const coverLetterSchema = z.object({
  job_id: z.coerce.number().int().positive(),
  tone: z.enum(["formal", "casual", "enthusiastic"]).default("formal"),
});

// POST /api/ai/cover-letter — gated by cover_letter plan limit (free: 5/mo, pro: unlimited)
aiRouter.post(
  "/cover-letter",
  planGate("cover_letter"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { job_id, tone } = coverLetterSchema.parse(req.body);
    const userId = req.ccUser!.id;

    const job = await getJobById(job_id);
    if (!job) throw new ApiError(404, "Job not found");

    const { rows: parsedRows } = await ccDb.query(
      `SELECT parsed_data FROM cc_parsed_resumes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (parsedRows.length === 0) {
      throw new ApiError(400, "No parsed resume on file", { hint: "Call /api/ai/parse-resume first" });
    }
    const resume = parsedRows[0].parsed_data as ParsedResume;

    const { content } = await aiClient.generateCoverLetter({ job, resume, tone });

    const client = await ccDb.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO cc_cover_letters (user_id, job_id, content, tone) VALUES ($1,$2,$3,$4) RETURNING *`,
        [userId, job_id, content, tone]
      );
      await client.query(
        `UPDATE cc_users SET cover_letter_count = cover_letter_count + 1, updated_at = now() WHERE id = $1`,
        [userId]
      );
      await client.query("COMMIT");
      res.status(201).json({ cover_letter: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  })
);

// PUT /api/ai/cover-letter/:id — user edits generated letter before use
aiRouter.put(
  "/cover-letter/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const content = z.string().min(1).parse(req.body.content);
    const { rows } = await ccDb.query(
      `UPDATE cc_cover_letters SET content = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING *`,
      [content, req.params.id, req.ccUser!.id]
    );
    if (rows.length === 0) throw new ApiError(404, "Cover letter not found");
    res.json({ cover_letter: rows[0] });
  })
);
