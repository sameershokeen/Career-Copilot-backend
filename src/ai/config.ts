function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) return "";
  return v;
}

export const config = {
  openrouter: {
    // NOTE: intentionally NOT validated eagerly here. This module is
    // imported at process startup by backend/src/services/aiClient.ts
    // (direct, same-process import — see that file's header comment).
    // Throwing at import time for a missing OPENROUTER_API_KEY would crash
    // the *entire* backend on boot, including routes that have nothing to
    // do with AI (jobs list, community, auth, etc.). Instead we validate
    // lazily, at the point an AI feature actually tries to call OpenRouter
    // — see openrouter/client.ts's assertApiKeyConfigured().
    apiKey: required("OPENROUTER_API_KEY"),
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    // Both free-tier on OpenRouter. Swappable via env — zero code changes.
    primaryModel: process.env.OPENROUTER_MODEL ?? "mistralai/mistral-7b-instruct",
    fallbackModel:
      process.env.OPENROUTER_FALLBACK_MODEL ?? "meta-llama/llama-3-8b-instruct",
    siteUrl: process.env.OPENROUTER_SITE_URL ?? "",
    appName: process.env.OPENROUTER_APP_NAME ?? "Career Copilot",
  },
  autofill: {
    headless: (process.env.AUTOFILL_HEADLESS ?? "true") === "true",
    timeoutMs: Number(process.env.AUTOFILL_TIMEOUT_MS ?? 30_000),
  },
};
