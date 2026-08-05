import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { scraperDb } from "../config/db";
import { cache, withCache, TTL } from "../services/cacheStore";
import { getJobById } from "../services/jobsEnrich";
import { asyncHandler } from "../middleware/errorHandler";
import { rateLimiters } from "../middleware/rateLimiter";

export const jobsRouter = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  region: z.enum(["india", "international"]).optional(),
  remote: z.coerce.boolean().optional(),
  postedWithin: z.enum(["24h", "3d", "7d"]).optional(),
  search: z.string().trim().min(1).optional(),
});

const INTERVAL_BY_WINDOW: Record<string, string> = {
  "24h": "1 day",
  "3d": "3 days",
  "7d": "7 days",
};

function buildFilters(q: z.infer<typeof listQuerySchema>) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.region) {
    params.push(q.region);
    clauses.push(`region = $${params.length}`);
  }
  if (q.remote !== undefined) {
    params.push(q.remote);
    clauses.push(`is_remote = $${params.length}`);
  }
  if (q.postedWithin) {
    clauses.push(`date_posted >= NOW() - INTERVAL '${INTERVAL_BY_WINDOW[q.postedWithin]}'`);
  }
  if (q.search) {
    params.push(`%${q.search}%`);
    clauses.push(`(title ILIKE $${params.length} OR company ILIKE $${params.length})`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// GET /api/jobs — paginated list, cached 15 min per filter combination
jobsRouter.get(
  "/",
  rateLimiters.jobsList,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const filtersHash = crypto.createHash("sha1").update(JSON.stringify(q)).digest("hex");
    const cacheKey = `jobs:list:${filtersHash}`;

    const result = await withCache(cacheKey, TTL.JOBS_LIST, async () => {
      const { where, params } = buildFilters(q);
      const offset = (q.page - 1) * q.pageSize;

      const countRes = await scraperDb.query(`SELECT COUNT(*)::int AS total FROM jobs ${where}`, params);
      const dataRes = await scraperDb.query(
        `SELECT * FROM jobs ${where} ORDER BY date_posted DESC NULLS LAST, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.pageSize, offset]
      );

      return {
        jobs: dataRes.rows,
        pagination: {
          page: q.page,
          pageSize: q.pageSize,
          total: countRes.rows[0].total as number,
          totalPages: Math.ceil(countRes.rows[0].total / q.pageSize),
        },
      };
    });

    res.json(result);
  })
);

// GET /api/jobs/:id — single job detail, cached 30 min
jobsRouter.get(
  "/:id",
  rateLimiters.jobsList,
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const job = await getJobById(id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  })
);

// POST /api/jobs/search — full-text search + chip filters, for the job board UI.
// Request/response shapes are the shared/src/index.ts JobFilters /
// PaginatedResponse<Job> contract — the frontend (JobBoardClient.tsx,
// lib/api.ts's getJobs()) sends { search?, chips, page, limit } and expects
// { data, total, page, limit, hasMore } back. This used to speak a different
// shape entirely ({region,remote,postedWithin} in, {jobs} out with no total),
// which crashed the job board on `jobs.length` since `data.data` was undefined.
const jobFiltersSchema = z.object({
  search: z.string().trim().min(1).optional(),
  chips: z.array(z.enum(["india", "remote", "abroad", "24h", "3days", "week"])).default([]),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const DATE_WINDOW_BY_CHIP: Record<string, string> = {
  "24h": "1 day",
  "3days": "3 days",
  "week": "7 days",
};

function buildChipFilters(q: z.infer<typeof jobFiltersSchema>) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  // Scope chips (india / remote / abroad) are OR'd together — a job can be
  // both remote AND india, so picking one shouldn't exclude the other.
  const scopeClauses: string[] = [];
  if (q.chips.includes("india")) scopeClauses.push(`(region = 'india' AND is_remote = false)`);
  if (q.chips.includes("remote")) scopeClauses.push(`is_remote = true`);
  if (q.chips.includes("abroad")) scopeClauses.push(`region = 'international'`);
  if (scopeClauses.length) clauses.push(`(${scopeClauses.join(" OR ")})`);

  // Date chips: if more than one is selected, use the widest window (most
  // inclusive) rather than trying to AND mutually-overlapping ranges.
  const dateChips = q.chips.filter((c) => c in DATE_WINDOW_BY_CHIP);
  if (dateChips.length) {
    const widest = dateChips.includes("week")
      ? "week"
      : dateChips.includes("3days")
      ? "3days"
      : "24h";
    clauses.push(`date_posted >= NOW() - INTERVAL '${DATE_WINDOW_BY_CHIP[widest]}'`);
  }

  if (q.search) {
    params.push(`%${q.search}%`);
    clauses.push(`(title ILIKE $${params.length} OR company ILIKE $${params.length})`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

jobsRouter.post(
  "/search",
  rateLimiters.jobsList,
  asyncHandler(async (req, res) => {
    const q = jobFiltersSchema.parse(req.body);
    const filtersHash = crypto.createHash("sha1").update(JSON.stringify(q)).digest("hex");
    const cacheKey = `jobs:list:${filtersHash}`;

    const result = await withCache(cacheKey, TTL.JOBS_LIST, async () => {
      const { where, params } = buildChipFilters(q);
      const offset = (q.page - 1) * q.limit;

      const countRes = await scraperDb.query(`SELECT COUNT(*)::int AS total FROM jobs ${where}`, params);
      const total = countRes.rows[0].total as number;

      const dataRes = await scraperDb.query(
        `SELECT * FROM jobs ${where} ORDER BY date_posted DESC NULLS LAST, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, offset]
      );

      return {
        data: dataRes.rows,
        total,
        page: q.page,
        limit: q.limit,
        hasMore: q.page * q.limit < total,
      };
    });

    res.json(result);
  })
);
