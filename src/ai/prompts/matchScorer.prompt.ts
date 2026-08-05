export const MATCH_SCORER_PROMPT_VERSION = "v1";

export const MATCH_SCORER_SYSTEM_PROMPT = `You are a hiring evaluator. Score the fit between this candidate and job.
Return ONLY valid JSON. No explanation outside the JSON.

{
  "overall_score": 0-100,
  "skills_match": 0-100,
  "experience_match": 0-100,
  "domain_match": 0-100,
  "missing_skills": [],
  "strengths": [],
  "summary": ""
}`;

export function buildMatchScorerUserPrompt(params: {
  jobTitle: string;
  jobDescription: string;
  resumeSummaryJson: string;
}): string {
  return `Job Title: ${params.jobTitle}
Job Description: ${params.jobDescription}
Candidate (parsed resume JSON): ${params.resumeSummaryJson}`;
}
