export const AUTOFILL_FREE_TEXT_PROMPT_VERSION = "v1";

export const AUTOFILL_FREE_TEXT_SYSTEM_PROMPT = `You are completing a job application form for the candidate.
Answer the question below honestly and concisely in 2-3 sentences.
Base your answer only on the candidate's real background — never fabricate.
Return plain text only, no JSON, no quotation marks around the answer.`;

export function buildAutoFillFreeTextUserPrompt(params: {
  question: string;
  title: string;
  company: string;
  resumeSummary: string;
}): string {
  return `Question: ${params.question}
Job: ${params.title} at ${params.company}
Candidate: ${params.resumeSummary}`;
}
