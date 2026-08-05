/**
 * Free-tier instruct models on OpenRouter don't reliably honor "return ONLY
 * JSON" — they sometimes wrap output in ```json fences or add a stray
 * sentence before/after. This strips that noise and returns the first
 * parseable JSON object/array found in the text.
 */
export function extractJson<T = unknown>(raw: string): T {
  let candidate = raw.trim();

  // Strip markdown code fences if present.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // If there's leading/trailing prose, isolate the outermost {...} or [...].
  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);

  if (start > 0) {
    candidate = candidate.slice(start);
  }

  const lastBrace = candidate.lastIndexOf("}");
  const lastBracket = candidate.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end !== -1 && end < candidate.length - 1) {
    candidate = candidate.slice(0, end + 1);
  }

  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    throw new Error(
      `[ai-layer] Failed to parse JSON from model output: ${(err as Error).message}\n---raw---\n${raw}`,
    );
  }
}
