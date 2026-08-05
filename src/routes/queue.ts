import { Router } from "express";
import { z } from "zod";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { getJobsByIds } from "../services/jobsEnrich";

export const queueRouter = Router();
queueRouter.use(requireAuth);

// GET /api/queue — full queue list enriched with live job details (app-level join)
queueRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rows } = await ccDb.query(
      `SELECT * FROM cc_apply_queue WHERE user_id = $1 AND status = 'pending' ORDER BY added_at DESC`,
      [req.ccUser!.id]
    );
    const jobsMap = await getJobsByIds(rows.map((r) => r.job_id));
    res.json({
      queue: rows.map((r) => ({ ...r, job: jobsMap.get(r.job_id) ?? null })),
      count: rows.length,
    });
  })
);

const addToQueueSchema = z.object({ job_id: z.coerce.number().int().positive() });

// POST /api/queue — "Add to Queue" button
queueRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { job_id } = addToQueueSchema.parse(req.body);
    const { rows } = await ccDb.query(
      `INSERT INTO cc_apply_queue (user_id, job_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id, job_id) WHERE status = 'pending' DO NOTHING
       RETURNING *`,
      [req.ccUser!.id, job_id]
    );
    res.status(201).json({ queued: rows[0] ?? { already_queued: true } });
  })
);

// DELETE /api/queue/:id — user removes entry from queue panel
queueRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rowCount } = await ccDb.query(
      `UPDATE cc_apply_queue SET status = 'removed' WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
      [req.params.id, req.ccUser!.id]
    );
    if (!rowCount) throw new ApiError(404, "Queue entry not found");
    res.json({ success: true });
  })
);
