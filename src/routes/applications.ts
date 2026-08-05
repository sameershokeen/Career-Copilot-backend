import { Router } from "express";
import { z } from "zod";
import { runBulkAutoFill, type AutoFillJobInput, type AutoFillResult } from "../ai";
import { ccDb } from "../config/db";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { rateLimiters } from "../middleware/rateLimiter";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { getJobsByIds, ScraperJob } from "../services/jobsEnrich";
import { sendEmail } from "../services/notify";
import { FREE_LIMITS, PRO_LIMITS } from "../middleware/planGate";

// Mounted at /api/apply in index.ts (its own router — see the header note
// on applicationsRouter below for why bulk-apply isn't just another route
// on that router).
export const applyRouter = Router();
applyRouter.use(requireAuth);

export const applicationsRouter = Router();
applicationsRouter.use(requireAuth);

async function logEvent(applicationId: string, event: string, detail?: string) {
  await ccDb.query(
    `INSERT INTO cc_application_logs (application_id, event, detail) VALUES ($1,$2,$3)`,
    [applicationId, event, detail ?? null]
  );
}

// Maps the ai layer's ApplicationStatus ("queued"|"applied"|"manual_required"|"failed")
// onto cc_applications.status directly — they share the same vocabulary by design.
async function persistResult(result: AutoFillResult) {
  await ccDb.query(
    `UPDATE cc_applications
     SET status = $1, applied_at = CASE WHEN $1 = 'applied' THEN now() ELSE applied_at END,
         prefilled_data = $2, updated_at = now()
     WHERE id = $3`,
    [result.status, result.prefilledData ?? null, result.applicationId]
  );
  for (const log of result.logs) {
    await logEvent(result.applicationId, log.event, log.detail);
  }
}

// POST /api/apply/bulk — "Bulk Approve & Auto-Apply".
// Frontend contract: no request body — it acts on every job the user currently
// has pending in cc_apply_queue, and returns { queued: number, ... } (the
// `queued` field is what DashboardShell's toast reads; the rest is extra
// detail the tracker/UI can use later without another contract change).
applyRouter.post(
  "/bulk",
  rateLimiters.applyBulk,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.ccUser!.id;
    const plan = req.ccUser!.plan;
    const limit = plan === "pro" ? PRO_LIMITS.auto_apply : FREE_LIMITS.auto_apply;
    let remaining = limit - req.ccUser!.apply_count;

    if (remaining <= 0) {
      throw new ApiError(402, "Plan limit reached", { feature: "auto_apply", plan, limit });
    }

    const { rows: queueRows } = await ccDb.query(
      `SELECT * FROM cc_apply_queue WHERE user_id = $1 AND status = 'pending' ORDER BY added_at ASC`,
      [userId]
    );
    if (queueRows.length === 0) throw new ApiError(404, "Queue is empty");

    const jobsMap = await getJobsByIds(queueRows.map((r) => r.job_id));

    const { rows: parsedRows } = await ccDb.query(
      `SELECT parsed_data FROM cc_parsed_resumes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (parsedRows.length === 0) {
      throw new ApiError(400, "No parsed resume on file", { hint: "Upload and parse a resume before auto-applying." });
    }
    const resume = parsedRows[0].parsed_data;

    // Everything beyond the remaining monthly quota is left untouched in the queue.
    const toProcess = queueRows.slice(0, remaining);
    const skipped = queueRows.slice(remaining);

    const created: { id: string; job_id: number }[] = [];
    for (const q of toProcess) {
      const job = jobsMap.get(q.job_id);
      const { rows } = await ccDb.query(
        `INSERT INTO cc_applications (user_id, job_id, status, job_title_snapshot, job_company_snapshot, job_url_snapshot)
         VALUES ($1,$2,'queued',$3,$4,$5) RETURNING id, job_id`,
        [userId, q.job_id, job?.title ?? null, job?.company ?? null, job?.job_url ?? job?.apply_url ?? null]
      );
      created.push(rows[0]);
      await logEvent(rows[0].id, "Application queued");
      await ccDb.query(`UPDATE cc_apply_queue SET status = 'approved' WHERE id = $1`, [q.id]);
    }

    // Fetch latest cover letter per job (best-effort — a missing cover letter
    // doesn't block auto-apply, the engine just skips that field).
    const coverLetterRows = await ccDb.query(
      `SELECT DISTINCT ON (job_id) job_id, content FROM cc_cover_letters
       WHERE user_id = $1 AND job_id = ANY($2::bigint[]) ORDER BY job_id, created_at DESC`,
      [userId, created.map((c) => c.job_id)]
    );
    const coverLetterByJob = new Map<number, string>(coverLetterRows.rows.map((r) => [r.job_id, r.content]));

    const jobInputs: AutoFillJobInput[] = created
      .map((app): AutoFillJobInput | null => {
        const job = jobsMap.get(app.job_id) as ScraperJob | undefined;
        if (!job || !(job.job_url || job.apply_url)) return null;
        return {
          applicationId: app.id,
          job: {
            id: job.id,
            title: job.title,
            company: job.company ?? null,
            job_url: job.job_url ?? job.apply_url ?? "",
            apply_url: job.apply_url ?? null,
            description: job.description ?? null,
            raw: job.raw ?? null,
          },
          resume,
          resumePdfUrl: null,
          coverLetterText: coverLetterByJob.get(app.job_id) ?? null,
        };
      })
      .filter((j): j is AutoFillJobInput => j !== null);

    // Jobs with no usable URL at all can't go through the engine — fail them directly.
    const unreachable = created.filter((app) => !jobInputs.some((j) => j.applicationId === app.id));
    for (const app of unreachable) {
      await ccDb.query(`UPDATE cc_applications SET status = 'failed', updated_at = now() WHERE id = $1`, [app.id]);
      await logEvent(app.id, "Application failed", "No job_url or apply_url available");
    }

    const summary = await runBulkAutoFill(jobInputs, {
      onJobComplete: (result) => persistResult(result),
    });

    if (summary.results.length + unreachable.length > 0) {
      await ccDb.query(
        `UPDATE cc_users SET apply_count = apply_count + $1, updated_at = now() WHERE id = $2`,
        [summary.results.length + unreachable.length, userId]
      );
    }

    const totalQueued = created.length;
    const totalFailed = summary.failed + unreachable.length;

    await sendEmail({
      userId,
      type: "apply_complete",
      to: req.ccUser!.email,
      subject: "Your Career Copilot bulk apply is complete",
      html: `<p>Applied: ${summary.applied} · Manual required: ${summary.manualRequired} · Failed: ${totalFailed}</p>`,
    });

    res.status(201).json({
      queued: totalQueued,
      skipped_due_to_plan_limit: skipped.length,
      summary: {
        applied: summary.applied,
        manual_required: summary.manualRequired,
        failed: totalFailed,
        paused: summary.paused,
      },
      results: summary.results,
    });
  })
);

// GET /api/applications — Kanban tracker, enriched with live job details
applicationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { rows } = await ccDb.query(
      `SELECT * FROM cc_applications WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.ccUser!.id]
    );
    const jobsMap = await getJobsByIds(rows.map((r) => r.job_id));
    res.json({
      applications: rows.map((r) => ({
        ...r,
        // Prefer live job data; fall back to the snapshot taken at apply time.
        job: jobsMap.get(r.job_id) ?? {
          id: r.job_id,
          title: r.job_title_snapshot,
          company: r.job_company_snapshot,
          job_url: r.job_url_snapshot,
        },
      })),
    });
  })
);

// GET /api/applications/:id/logs — collapsible log entries per card
applicationsRouter.get(
  "/:id/logs",
  asyncHandler(async (req: AuthedRequest, res) => {
    const owns = await ccDb.query(`SELECT 1 FROM cc_applications WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.ccUser!.id,
    ]);
    if (owns.rows.length === 0) throw new ApiError(404, "Application not found");

    const { rows } = await ccDb.query(
      `SELECT * FROM cc_application_logs WHERE application_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ logs: rows });
  })
);

const statusUpdateSchema = z.object({
  status: z.enum(["queued", "applied", "viewed", "interview", "offer", "rejected", "manual_required", "failed"]),
});

// PUT /api/applications/:id/status — manual status update button
// (was PATCH — changed to PUT to match the frontend's lib/api.ts contract)
applicationsRouter.put(
  "/:id/status",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { status } = statusUpdateSchema.parse(req.body);
    const { rows: before } = await ccDb.query(
      `SELECT status FROM cc_applications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.ccUser!.id]
    );
    if (before.length === 0) throw new ApiError(404, "Application not found");

    await ccDb.query(`UPDATE cc_applications SET status = $1, updated_at = now() WHERE id = $2`, [
      status,
      req.params.id,
    ]);
    await logEvent(req.params.id, "Status manually updated", `${before[0].status} → ${status}`);

    res.json({ success: true });
  })
);
