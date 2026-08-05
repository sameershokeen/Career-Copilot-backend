import { autoFillAndSubmit } from "./autoFillEngine.service";
import { logger } from "../utils/logger";
import type { AutoFillJobInput, AutoFillResult } from "../types/index";

const BATCH_SIZE = 5;
const SCOPE = "autoFillBulk";

export interface BulkAutoFillOptions {
  /**
   * Called before each job starts, so the backend can check plan limits
   * mid-batch. Return false to pause the remaining queue without
   * incrementing that job's apply_count, per the spec's failure-handling
   * rule ("plan limit hit mid-batch -> pause remaining queue, notify user,
   * do not increment count for unprocessed jobs").
   */
  canProceed?: (job: AutoFillJobInput) => Promise<boolean> | boolean;
  /** Called after each job resolves, useful for streaming progress to the UI. */
  onJobComplete?: (result: AutoFillResult) => void | Promise<void>;
}

export interface BulkAutoFillSummary {
  results: AutoFillResult[];
  applied: number;
  manualRequired: number;
  failed: number;
  paused: boolean;
}

/**
 * Runs the approved bulk queue in parallel batches of 5, as specified in
 * the Auto-Apply Pipeline. Stops early (paused = true) if canProceed
 * returns false for a job — e.g. a free-tier user hit their monthly limit
 * partway through the batch.
 */
export async function runBulkAutoFill(
  jobs: AutoFillJobInput[],
  options: BulkAutoFillOptions = {},
): Promise<BulkAutoFillSummary> {
  const results: AutoFillResult[] = [];
  let paused = false;

  for (let i = 0; i < jobs.length && !paused; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (job) => {
        const allowed = options.canProceed ? await options.canProceed(job) : true;
        if (!allowed) {
          paused = true;
          logger.warn(SCOPE, "plan limit reached mid-batch, pausing remaining queue", {
            applicationId: job.applicationId,
          });
          return null;
        }
        const result = await autoFillAndSubmit(job);
        await options.onJobComplete?.(result);
        return result;
      }),
    );

    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  return {
    results,
    applied: results.filter((r) => r.status === "applied").length,
    manualRequired: results.filter((r) => r.status === "manual_required").length,
    failed: results.filter((r) => r.status === "failed").length,
    paused,
  };
}
