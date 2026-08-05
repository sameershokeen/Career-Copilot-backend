import { Pool } from "pg";
import { env } from "./env";

/**
 * TWO-DATABASE ARCHITECTURE
 * -------------------------
 * The original spec assumed one Neon database holding both the scraper's
 * `jobs`/`scrape_runs` tables and Career Copilot's `cc_*` tables, with real
 * foreign keys between them (e.g. cc_applications.job_id -> jobs.id).
 *
 * In this deployment the scraper lives in its OWN database, separate from
 * Career Copilot's database. Postgres cannot enforce a foreign key across
 * two different database instances, so:
 *
 *   - `ccDb`      -> career-copilot's own database. Owns every cc_* table.
 *   - `scraperDb` -> the scraper's database. READ-ONLY from this backend.
 *                    We never write to `jobs` or `scrape_runs`.
 *
 * Consequences baked into the schema/routes:
 *   1. cc_apply_queue.job_id, cc_applications.job_id, cc_cover_letters.job_id,
 *      and cc_match_scores.job_id are plain BIGINT columns with NO foreign
 *      key constraint (cross-db FKs aren't possible).
 *   2. Anywhere the UI needs "application + job details" (e.g. the tracker),
 *      the backend does an app-level join: fetch cc_applications rows from
 *      ccDb, collect their job_ids, then fetch matching rows from scraperDb's
 *      `jobs` table and merge in memory. See services/jobsEnrich.ts.
 *   3. If a job is later deleted from the scraper DB, historical
 *      applications/cover letters/match scores are NOT deleted — they just
 *      render without live job details (title/company snapshot is safest,
 *      see cc_applications design note in db/migrations).
 */

export const ccDb = new Pool({
  connectionString: env.CC_DATABASE_URL,
  max: 10,
  ssl: env.CC_DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

export const scraperDb = new Pool({
  connectionString: env.SCRAPER_DATABASE_URL,
  max: 5,
  ssl: env.SCRAPER_DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

ccDb.on("error", (err) => console.error("[ccDb] unexpected error on idle client", err));
scraperDb.on("error", (err) => console.error("[scraperDb] unexpected error on idle client", err));

export async function assertScraperDbIsReadOnly() {
  // Defensive check, run once at boot: fail loudly if someone points
  // SCRAPER_DATABASE_URL at a role with write access and code accidentally
  // tries to write through this pool later.
  try {
    await scraperDb.query("SELECT 1");
  } catch (err) {
    console.error("[scraperDb] connection check failed:", err);
  }
}
