import type { ParsedResume as AiParsedResume, MatchScore, CoverLetterOutput, Tone } from "../ai";
import { parseResume as aiParseResume, computeMatchScore, generateCoverLetter as aiGenerateCoverLetter } from "../ai";
import type { ScraperJob } from "./jobsEnrich";

/**
 * ARCHITECTURE CHANGE (see chat): Part 3 (ai/) is a real, typechecked
 * workspace package that exports plain async functions meant to be called
 * in-process (see ai/src/index.ts's own header comment: "backend/ imports
 * exclusively from this file"). The previous version of this file only
 * knew how to reach the AI layer over HTTP via AI_SERVICE_URL, which is
 * empty by default -> every call 501'd and bulk-apply silently never
 * called the AI layer at all (every application stayed "queued").
 *
 * This does the direct, same-process import the spec always intended.
 * The AI layer lives locally at `src/ai/` (folded in from the original
 * `@career-copilot/ai` workspace package so this backend can be deployed
 * as a fully standalone project, e.g. on Railway, with no monorepo/
 * workspace tooling required).
 */

export type ParsedResume = AiParsedResume;
export type { MatchScore, CoverLetterOutput, Tone };

export const aiClient = {
  parseResume: (input: { pdfBase64?: string; rawText?: string; resumeId?: string }) =>
    aiParseResume({ pdfBase64: input.pdfBase64, rawText: input.rawText, resumeId: input.resumeId }),

  scoreMatch: (input: { job: ScraperJob; resume: ParsedResume }): Promise<MatchScore> =>
    computeMatchScore({
      job: { id: input.job.id, title: input.job.title, description: input.job.description ?? null, raw: input.job.raw ?? null },
      resume: input.resume,
    }),

  generateCoverLetter: (input: { job: ScraperJob; resume: ParsedResume; tone: Tone }): Promise<CoverLetterOutput> =>
    aiGenerateCoverLetter({
      job: { title: input.job.title, company: input.job.company ?? null, description: input.job.description ?? null, raw: input.job.raw ?? null },
      resume: input.resume,
      tone: input.tone,
    }),
};
