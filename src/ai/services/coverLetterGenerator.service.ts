import { chatCompletion } from "../openrouter/client";
import {
  buildCoverLetterSystemPrompt,
  buildCoverLetterUserPrompt,
} from "../prompts/coverLetter.prompt";
import { logger } from "../utils/logger";
import {
  CoverLetterInputSchema,
  CoverLetterOutputSchema,
  type CoverLetterInput,
  type CoverLetterOutput,
} from "../types/index";

const SCOPE = "coverLetterGenerator";

const BANNED_PHRASES = [
  "i am writing to express my interest",
  "i am a passionate",
  "team player",
];

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function violatesBannedPhrases(text: string): string | null {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.find((phrase) => lower.includes(phrase)) ?? null;
}

function resolveDescription(job: CoverLetterInput["job"]): string {
  if (job.description && job.description.trim()) return job.description.trim();
  const raw = job.raw?.["description"];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "(No job description available — write generally about the role title and company.)";
}

/**
 * Generates a 3-paragraph, <=250 word cover letter. Retries once with a
 * corrective instruction if the model exceeds the word budget or slips in
 * a banned generic phrase — cheap models drift on constraints occasionally.
 */
export async function generateCoverLetter(
  rawInput: CoverLetterInput,
): Promise<CoverLetterOutput> {
  const input = CoverLetterInputSchema.parse(rawInput);
  const description = resolveDescription(input.job);
  const company = input.job.company ?? "the company";

  const baseUserPrompt = buildCoverLetterUserPrompt({
    title: input.job.title,
    company,
    description,
    resumeSummary: JSON.stringify({
      summary: input.resume.summary,
      skills: input.resume.skills,
      experience: input.resume.experience,
      projects: input.resume.projects,
    }),
  });

  const attempt = async (correction?: string) => {
    const { text, model, usedFallback } = await chatCompletion({
      systemPrompt: buildCoverLetterSystemPrompt(input.tone),
      userPrompt: correction ? `${baseUserPrompt}\n\n${correction}` : baseUserPrompt,
      temperature: 0.7,
      maxTokens: 500,
    });
    return { text: text.trim(), model, usedFallback };
  };

  let { text, model, usedFallback } = await attempt();
  let wordCount = countWords(text);
  const banned = violatesBannedPhrases(text);

  if (wordCount > 250 || banned) {
    logger.warn(SCOPE, "output violated constraints, retrying once", {
      wordCount,
      banned,
    });
    const retryResult = await attempt(
      `Your previous draft was ${wordCount} words${banned ? ` and used the banned phrase "${banned}"` : ""}. ` +
        `Rewrite it: stay at or under 250 words, and never use any of the banned phrases.`,
    );
    text = retryResult.text;
    model = retryResult.model;
    usedFallback = usedFallback || retryResult.usedFallback;
    wordCount = countWords(text);
  }

  logger.info(SCOPE, "cover letter generated", { model, usedFallback, wordCount });

  return CoverLetterOutputSchema.parse({
    content: text,
    word_count: wordCount,
    tone: input.tone,
  });
}
