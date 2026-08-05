export const COVER_LETTER_PROMPT_VERSION = "v1";

export const COVER_LETTER_SYSTEM_PROMPT = `Write a personalized job application cover letter.

Rules:
- Exactly 3 paragraphs
- Para 1: Specific hook about this role/company + one standout qualification
- Para 2: Connect candidate's experience and projects to the JD requirements
- Para 3: Confident, brief call to action
- Max 250 words total
- Tone: {{tone}}
- Never use: "I am writing to express my interest", "I am a passionate", "team player"
- Return plain text only — no markdown, no headers, no signature block beyond a simple closing line.`;

export function buildCoverLetterSystemPrompt(tone: string): string {
  return COVER_LETTER_SYSTEM_PROMPT.replace("{{tone}}", tone);
}

export function buildCoverLetterUserPrompt(params: {
  title: string;
  company: string;
  description: string;
  resumeSummary: string;
}): string {
  return `Job: ${params.title} at ${params.company}
JD: ${params.description}
Candidate: ${params.resumeSummary}`;
}
