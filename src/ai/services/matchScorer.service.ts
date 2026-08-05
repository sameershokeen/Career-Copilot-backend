import { chatCompletion } from "../openrouter/client";
import {
  MATCH_SCORER_SYSTEM_PROMPT,
  buildMatchScorerUserPrompt,
} from "../prompts/matchScorer.prompt";
import { extractJson } from "../utils/jsonExtractor";
import { logger } from "../utils/logger";
import {
  MatchScoreSchema,
  MatchScorerInputSchema,
  type MatchScore,
  type MatchScorerInput,
} from "../types/index";

const SCOPE = "matchScorer";

/**
 * Resolves job description text with the fallback chain described in the
 * spec: `description` column first, then `raw->>'description'` from the
 * scraper's raw JSONB blob. Returns null if genuinely unavailable.
 */
function resolveJobDescription(job: MatchScorerInput["job"]): string | null {
  if (job.description && job.description.trim().length > 0) {
    return job.description.trim();
  }
  const rawDescription = job.raw?.["description"];
  if (typeof rawDescription === "string" && rawDescription.trim().length > 0) {
    return rawDescription.trim();
  }
  return null;
}

const LOW_CONFIDENCE_SCORE: Omit<MatchScore, "low_confidence"> = {
  overall_score: 0,
  skills_match: 0,
  experience_match: 0,
  domain_match: 0,
  missing_skills: [],
  strengths: [],
  summary:
    "Unable to compute a reliable match score: no job description was available " +
    "(neither the description column nor raw->>'description' contained text).",
};

export async function computeMatchScore(rawInput: MatchScorerInput): Promise<MatchScore> {
  const input = MatchScorerInputSchema.parse(rawInput);

  const description = resolveJobDescription(input.job);
  if (!description) {
    logger.warn(SCOPE, "no description available, returning low-confidence score", {
      jobId: input.job.id,
    });
    return MatchScoreSchema.parse({ ...LOW_CONFIDENCE_SCORE, low_confidence: true });
  }

  const { text, model, usedFallback } = await chatCompletion({
    systemPrompt: MATCH_SCORER_SYSTEM_PROMPT,
    userPrompt: buildMatchScorerUserPrompt({
      jobTitle: input.job.title,
      jobDescription: description,
      resumeSummaryJson: JSON.stringify(input.resume),
    }),
    temperature: 0.2,
    maxTokens: 600,
  });

  logger.info(SCOPE, "match score computed", {
    model,
    usedFallback,
    jobId: input.job.id,
  });

  const json = extractJson<unknown>(text);
  return MatchScoreSchema.parse({ ...(json as object), low_confidence: false });
}
