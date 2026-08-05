import { z } from "zod";

/* ────────────────────────────────────────────────────────────────
 * Resume Parser
 * ────────────────────────────────────────────────────────────── */

export const SocialLinksSchema = z.object({
  linkedin: z.string().default(""),
  github: z.string().default(""),
  portfolio: z.string().default(""),
  twitter: z.string().default(""),
  other: z.array(z.string()).default([]),
});

export const ExperienceEntrySchema = z.object({
  title: z.string().default(""),
  company: z.string().default(""),
  duration: z.string().default(""),
  bullets: z.array(z.string()).default([]),
});

export const ProjectEntrySchema = z.object({
  title: z.string().default(""),
  description: z.string().default(""),
  tech_stack: z.array(z.string()).default([]),
  link: z.string().default(""),
});

export const EducationEntrySchema = z.object({
  degree: z.string().default(""),
  institution: z.string().default(""),
  year: z.string().default(""),
  grade: z.string().default(""),
});

export const ParsedResumeSchema = z.object({
  name: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  summary: z.string().default(""),
  social_links: SocialLinksSchema.default({}),
  skills: z.array(z.string()).default([]),
  experience: z.array(ExperienceEntrySchema).default([]),
  projects: z.array(ProjectEntrySchema).default([]),
  education: z.array(EducationEntrySchema).default([]),
});
export type ParsedResume = z.infer<typeof ParsedResumeSchema>;

export const ResumeParserInputSchema = z.object({
  // Exactly one of these should be provided
  pdfBase64: z.string().optional(),
  rawText: z.string().optional(),
  resumeId: z.string().uuid().optional(), // for caller-side traceability only
});
export type ResumeParserInput = z.infer<typeof ResumeParserInputSchema>;

/* ────────────────────────────────────────────────────────────────
 * Match Scorer
 * ────────────────────────────────────────────────────────────── */

export const MatchScoreSchema = z.object({
  overall_score: z.number().min(0).max(100),
  skills_match: z.number().min(0).max(100),
  experience_match: z.number().min(0).max(100),
  domain_match: z.number().min(0).max(100),
  missing_skills: z.array(z.string()).default([]),
  strengths: z.array(z.string()).default([]),
  summary: z.string().default(""),
  low_confidence: z.boolean().default(false), // true when JD text was unavailable
});
export type MatchScore = z.infer<typeof MatchScoreSchema>;

export const MatchScorerInputSchema = z.object({
  job: z.object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    description: z.string().nullable().optional(),
    raw: z.record(z.any()).nullable().optional(), // fallback source: raw->>'description'
  }),
  resume: ParsedResumeSchema,
});
export type MatchScorerInput = z.infer<typeof MatchScorerInputSchema>;

/* ────────────────────────────────────────────────────────────────
 * Cover Letter Generator
 * ────────────────────────────────────────────────────────────── */

export const ToneSchema = z.enum(["formal", "casual", "enthusiastic"]);
export type Tone = z.infer<typeof ToneSchema>;

export const CoverLetterInputSchema = z.object({
  job: z.object({
    title: z.string(),
    company: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    raw: z.record(z.any()).nullable().optional(),
  }),
  resume: ParsedResumeSchema,
  tone: ToneSchema.default("formal"),
});
export type CoverLetterInput = z.infer<typeof CoverLetterInputSchema>;

export const CoverLetterOutputSchema = z.object({
  content: z.string(),
  word_count: z.number(),
  tone: ToneSchema,
});
export type CoverLetterOutput = z.infer<typeof CoverLetterOutputSchema>;

/* ────────────────────────────────────────────────────────────────
 * Auto-Fill Engine
 * ────────────────────────────────────────────────────────────── */

export const ApplicationStatusSchema = z.enum([
  "queued",
  "applied",
  "manual_required",
  "failed",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const AutoFillJobInputSchema = z.object({
  applicationId: z.string(),
  job: z.object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    company: z.string().nullable().optional(),
    job_url: z.string(),
    apply_url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    raw: z.record(z.any()).nullable().optional(),
  }),
  resume: ParsedResumeSchema,
  resumePdfUrl: z.string().nullable().optional(),
  coverLetterText: z.string().nullable().optional(),
});
export type AutoFillJobInput = z.infer<typeof AutoFillJobInputSchema>;

export const AutoFillLogEventSchema = z.object({
  event: z.string(),
  detail: z.string().optional(),
  at: z.string(), // ISO timestamp
});
export type AutoFillLogEvent = z.infer<typeof AutoFillLogEventSchema>;

export const AutoFillResultSchema = z.object({
  applicationId: z.string(),
  status: ApplicationStatusSchema,
  prefilledData: z.record(z.any()).nullable().optional(),
  logs: z.array(AutoFillLogEventSchema),
});
export type AutoFillResult = z.infer<typeof AutoFillResultSchema>;

/* ────────────────────────────────────────────────────────────────
 * OpenRouter client
 * ────────────────────────────────────────────────────────────── */

export interface ChatCompletionRequest {
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Force a specific model instead of the configured primary/fallback pair */
  modelOverride?: string;
}

export interface ChatCompletionResult {
  text: string;
  model: string;
  usedFallback: boolean;
}
