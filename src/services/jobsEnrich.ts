import { scraperDb } from "../config/db";
import { cache, TTL } from "./cacheStore";

export interface ScraperJob {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  region: string;
  country: string | null;
  is_remote: boolean;
  source_site: string;
  sources: string[];
  job_url: string | null;
  apply_url: string | null;
  description?: string | null;
  skills?: string[] | null;
  job_type?: string | null;
  date_posted?: string | null;
  first_seen_at?: string | null;
  raw?: Record<string, unknown> | null;
}

/** Fetch a single job from the scraper DB, cached 30 min per spec. */
export async function getJobById(jobId: number): Promise<ScraperJob | null> {
  const key = `jobs:detail:${jobId}`;
  const cached = cache.get<ScraperJob | null>(key);
  if (cached !== undefined) return cached;

  const { rows } = await scraperDb.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  const job = (rows[0] as ScraperJob) ?? null;
  cache.set(key, job, TTL.JOBS_DETAIL);
  return job;
}

/**
 * Batch fetch jobs by id from the scraper DB — used to enrich cc_applications
 * / cc_apply_queue rows (which only store job_id) with live title/company/etc.
 * Uncached (batch shape varies too much to key well); callers should rely on
 * the per-job 30-min cache in getJobById for hot paths instead when possible.
 */
export async function getJobsByIds(jobIds: number[]): Promise<Map<number, ScraperJob>> {
  if (jobIds.length === 0) return new Map();
  const unique = [...new Set(jobIds)];
  const { rows } = await scraperDb.query(
    `SELECT * FROM jobs WHERE id = ANY($1::bigint[])`,
    [unique]
  );
  const map = new Map<number, ScraperJob>();
  for (const row of rows as ScraperJob[]) map.set(row.id, row);
  return map;
}

/** Extract job description text, falling back to raw JSONB per spec's null-handling rule. */
export function resolveDescription(job: ScraperJob | undefined | null): string | null {
  if (!job) return null;
  if (job.description) return job.description;
  const raw = job.raw as Record<string, unknown> | null | undefined;
  const fromRaw = raw?.description;
  return typeof fromRaw === "string" && fromRaw.length > 0 ? fromRaw : null;
}
