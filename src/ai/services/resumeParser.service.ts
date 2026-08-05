import { chatCompletion } from "../openrouter/client";
import {
  RESUME_PARSER_SYSTEM_PROMPT,
  buildResumeParserUserPrompt,
} from "../prompts/resumeParser.prompt";
import { extractTextFromPdfBase64 } from "./pdfExtractor";
import { extractJson } from "../utils/jsonExtractor";
import { logger } from "../utils/logger";
import {
  ParsedResumeSchema,
  ResumeParserInputSchema,
  type ParsedResume,
  type ResumeParserInput,
} from "../types/index";

const SCOPE = "resumeParser";

/**
 * Parses a resume (PDF or raw text) into the canonical structured shape
 * that feeds every other AI feature (match scorer, cover letter generator,
 * auto-fill engine). Caller is responsible for persisting the result to
 * cc_parsed_resumes.
 */
export async function parseResume(rawInput: ResumeParserInput): Promise<ParsedResume> {
  const input = ResumeParserInputSchema.parse(rawInput);

  if (!input.pdfBase64 && !input.rawText) {
    throw new Error("[ai-layer] parseResume requires either pdfBase64 or rawText.");
  }

  const resumeText = input.rawText ?? (await extractTextFromPdfBase64(input.pdfBase64!));

  const { text, model, usedFallback } = await chatCompletion({
    systemPrompt: RESUME_PARSER_SYSTEM_PROMPT,
    userPrompt: buildResumeParserUserPrompt(resumeText),
    temperature: 0.2, // low temp — this is extraction, not generation
    maxTokens: 1200,
  });

  logger.info(SCOPE, "resume parsed", { model, usedFallback, resumeId: input.resumeId });

  const json = extractJson<unknown>(text);
  return ParsedResumeSchema.parse(json);
}
