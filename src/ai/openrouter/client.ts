import { config } from "../config";
import { logger } from "../utils/logger";
import type { ChatCompletionRequest, ChatCompletionResult } from "../types/index";

const SCOPE = "openrouter";

function assertApiKeyConfigured() {
  if (!config.openrouter.apiKey) {
    throw new Error(
      "[ai-layer] OPENROUTER_API_KEY is not set. AI features (resume parsing, " +
        "match scoring, cover letters, auto-fill free text) are unavailable " +
        "until it's configured; the rest of the app runs fine without it.",
    );
  }
}

interface OpenRouterChoice {
  message: { content: string };
}
interface OpenRouterResponse {
  choices: OpenRouterChoice[];
  model: string;
}

async function callModel(
  model: string,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const messages = [
    ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
    { role: "user", content: req.userPrompt },
  ];

  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      // Optional but recommended by OpenRouter for attribution/rate-limit tiers.
      "HTTP-Referer": config.openrouter.siteUrl,
      "X-Title": config.openrouter.appName,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 800,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${model} responded ${res.status}: ${body}`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`OpenRouter ${model} returned no content`);
  }
  return { text, model: data.model ?? model, usedFallback: false };
}

/**
 * Single entry point for every AI feature. Tries the primary (free) model;
 * on any failure — timeout, 429, 5xx, empty response — falls back once to
 * the secondary (free) model. Both models are env-injected, so swapping
 * providers/models never touches feature code.
 */
export async function chatCompletion(
  req: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  assertApiKeyConfigured();
  const primary = req.modelOverride ?? config.openrouter.primaryModel;

  try {
    return await callModel(primary, req);
  } catch (primaryErr) {
    logger.warn(SCOPE, "primary model failed, trying fallback", {
      primary,
      error: (primaryErr as Error).message,
    });

    if (req.modelOverride) {
      // Caller pinned a specific model — don't silently swap it out.
      throw primaryErr;
    }

    try {
      const result = await callModel(config.openrouter.fallbackModel, req);
      return { ...result, usedFallback: true };
    } catch (fallbackErr) {
      logger.error(SCOPE, "fallback model also failed", {
        fallback: config.openrouter.fallbackModel,
        error: (fallbackErr as Error).message,
      });
      throw new Error(
        `[ai-layer] Both primary (${primary}) and fallback (${config.openrouter.fallbackModel}) models failed.`,
      );
    }
  }
}
