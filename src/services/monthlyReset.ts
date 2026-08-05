import { ccDb } from "../config/db";

/**
 * Resets apply_count and cover_letter_count to 0 for every free-plan user.
 * Per spec section 10, this should run on the 1st of each month.
 *
 * No external cron dependency here — call this from whatever scheduler you
 * deploy with (Railway/Render cron job, GitHub Actions on a schedule, or a
 * simple `setInterval` check in index.ts that runs once/day and only acts on
 * the 1st). Kept as a standalone function so any of those can call it.
 */
export async function resetMonthlyCounts() {
  const { rowCount } = await ccDb.query(
    `UPDATE cc_users SET apply_count = 0, cover_letter_count = 0, updated_at = now() WHERE plan = 'free'`
  );
  console.log(`[monthlyReset] reset counts for ${rowCount} free users`);
  return rowCount;
}

/** Lightweight in-process scheduler: checks once/day, runs the reset only on the 1st. */
export function startMonthlyResetScheduler() {
  let lastRunDate: string | null = null;

  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCDate() === 1 && lastRunDate !== today) {
      lastRunDate = today;
      try {
        await resetMonthlyCounts();
      } catch (err) {
        console.error("[monthlyReset] failed:", err);
      }
    }
  }, 24 * 60 * 60 * 1000); // check once/day

  console.log("[monthlyReset] scheduler started (in-process, checks daily)");
}
