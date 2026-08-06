import { chromium, type Browser, type Page } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { chatCompletion } from "../openrouter/client";
import {
  AUTOFILL_FREE_TEXT_SYSTEM_PROMPT,
  buildAutoFillFreeTextUserPrompt,
} from "../prompts/autoFillFreeText.prompt";
import { buildStandardFieldTargets, buildFileFieldTargets } from "./autoFillFieldMap";
import { logger } from "../utils/logger";
import { config } from "../config";
import {
  AutoFillJobInputSchema,
  AutoFillResultSchema,
  type AutoFillJobInput,
  type AutoFillResult,
  type AutoFillLogEvent,
} from "../types/index";

const SCOPE = "autoFillEngine";

// Common CAPTCHA / bot-detection fingerprints seen across ATS portals.
const CAPTCHA_MARKERS = [
  "recaptcha",
  "hcaptcha",
  "cf-turnstile",
  "cloudflare",
  "are you a robot",
  "verify you are human",
  "unusual traffic",
  "px-captcha", // PerimeterX
  "datadome",
];

function makeLog(event: string, detail?: string): AutoFillLogEvent {
  return { event, detail, at: new Date().toISOString() };
}

async function detectCaptcha(page: Page): Promise<boolean> {
  const content = (await page.content()).toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => content.includes(marker));
}

/** Answers free-text application questions ("Why do you want this role?") via AI. */
async function answerFreeTextQuestion(params: {
  question: string;
  title: string;
  company: string;
  resumeSummary: string;
}): Promise<string> {
  const { text } = await chatCompletion({
    systemPrompt: AUTOFILL_FREE_TEXT_SYSTEM_PROMPT,
    userPrompt: buildAutoFillFreeTextUserPrompt(params),
    temperature: 0.5,
    maxTokens: 200,
  });
  return text.trim();
}

/**
 * Fills every matched standard field + free-text question on the page.
 * Returns the map of what was actually filled, for prefilled_data on
 * manual_required outcomes and for auditability on success.
 */
async function fillForm(
  page: Page,
  input: AutoFillJobInput,
): Promise<Record<string, string>> {
  const filled: Record<string, string> = {};

  const targets = buildStandardFieldTargets(input.resume, {
    resumePdfUrl: input.resumePdfUrl,
    coverLetterText: input.coverLetterText,
  });

  for (const target of targets) {
    for (const selector of target.selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      try {
        // This tsconfig has no "dom" lib (it's a Node service), so Playwright's
        // element type here isn't a full DOM Element and TS can't see `tagName`
        // on it without that lib. We don't actually need the tag name — the
        // fill() call below works the same for inputs and textareas — so just
        // probe fillability directly instead of branching on tag.
        await locator.fill(target.value);
        filled[target.field] = target.value;
        break;
      } catch {
        // selector matched but fill failed (hidden/disabled) — try next candidate
        continue;
      }
    }
  }

  const fileTargets = buildFileFieldTargets(input.resumePdfUrl);
  for (const target of fileTargets) {
    const locator = page.locator(target.selectors.join(", ")).first();
    if ((await locator.count()) > 0) {
      try {
        let filePath = target.url;
        let isTempFile = false;
        if (target.url.startsWith("http://") || target.url.startsWith("https://")) {
          const res = await fetch(target.url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            filePath = path.join(os.tmpdir(), `resume-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
            await fs.promises.writeFile(filePath, buffer);
            isTempFile = true;
          }
        }
        if (fs.existsSync(filePath)) {
          await locator.setInputFiles(filePath);
          filled["resume_upload"] = "uploaded";
          if (isTempFile) {
            await fs.promises.unlink(filePath).catch(() => undefined);
          }
        } else {
          filled["resume_upload"] = "file_not_found";
        }
      } catch (err) {
        logger.warn(SCOPE, `Failed to attach resume file: ${err}`);
        filled["resume_upload"] = "failed";
      }
    }
  }

  // Free-text long-answer questions: look for textareas not already matched
  // (e.g. cover letter box) that have an associated label/placeholder.
  const textareas = page.locator("textarea");
  const count = await textareas.count();
  for (let i = 0; i < count; i++) {
    const ta = textareas.nth(i);
    const alreadyFilled = (await ta.inputValue().catch(() => "")) !== "";
    if (alreadyFilled) continue;

    const question =
      (await ta.getAttribute("placeholder")) ??
      (await ta.getAttribute("aria-label")) ??
      "";
    if (!question || question.length < 8) continue; // not a real question

    const answer = await answerFreeTextQuestion({
      question,
      title: input.job.title,
      company: input.job.company ?? "the company",
      resumeSummary: input.resume.summary,
    });
    await ta.fill(answer).catch(() => undefined);
    filled[`freetext:${question.slice(0, 40)}`] = answer;
  }

  return filled;
}

async function submitForm(page: Page): Promise<void> {
  const submitButton = page
    .locator(
      'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")',
    )
    .first();
  await submitButton.click({ timeout: config.autofill.timeoutMs });
}

/**
 * Runs the auto-fill + submit flow for a single job in the approved bulk
 * queue. Implements the failure-handling matrix from the pipeline spec:
 *   - CAPTCHA/bot detection  -> manual_required, prefilled form JSON saved
 *   - network failure        -> failed, eligible for one-click retry
 *   - API/page error         -> retry once after 30s, then failed
 */
export async function autoFillAndSubmit(
  rawInput: AutoFillJobInput,
): Promise<AutoFillResult> {
  const input = AutoFillJobInputSchema.parse(rawInput);
  const logs: AutoFillLogEvent[] = [makeLog("Application queued")];
  const targetUrl = input.job.apply_url || input.job.job_url;

  let browser: Browser | undefined;
  try {
    const result = await runAttempt();
    return result;
  } finally {
    await browser?.close().catch(() => undefined);
  }

  async function runAttempt(retrying = false): Promise<AutoFillResult> {
    let page: Page | undefined;
    try {
      browser = browser ?? (await chromium.launch({ headless: config.autofill.headless }));
      page = await browser.newPage();
      await page.goto(targetUrl, {
        timeout: config.autofill.timeoutMs,
        waitUntil: "domcontentloaded",
      });

      if (await detectCaptcha(page)) {
        logs.push(makeLog("CAPTCHA / bot detection encountered"));
        const prefilled = await fillForm(page, input).catch(() => ({}));
        logs.push(makeLog("Form pre-filled, saved for manual completion"));
        return AutoFillResultSchema.parse({
          applicationId: input.applicationId,
          status: "manual_required",
          prefilledData: prefilled,
          logs,
        });
      }

      const filled = await fillForm(page, input);
      logs.push(makeLog("Form fields filled", `${Object.keys(filled).length} fields`));

      await submitForm(page);
      logs.push(makeLog("Application submitted via auto-apply"));

      return AutoFillResultSchema.parse({
        applicationId: input.applicationId,
        status: "applied",
        prefilledData: null,
        logs,
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const isNetworkError = /net::|ERR_|timeout|ECONNRESET|ENOTFOUND/i.test(message);

      if (isNetworkError) {
        logger.warn(SCOPE, "network failure during auto-apply", {
          applicationId: input.applicationId,
          message,
        });
        logs.push(makeLog("Network failure", message));
        return AutoFillResultSchema.parse({
          applicationId: input.applicationId,
          status: "failed",
          prefilledData: null,
          logs,
        });
      }

      if (!retrying) {
        logger.warn(SCOPE, "error during auto-apply, retrying once after 30s", {
          applicationId: input.applicationId,
          message,
        });
        logs.push(makeLog("Error encountered, retrying in 30s", message));
        await page?.close().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        return runAttempt(true);
      }

      logger.error(SCOPE, "auto-apply failed after retry", {
        applicationId: input.applicationId,
        message,
      });
      logs.push(makeLog("Failed after retry", message));
      return AutoFillResultSchema.parse({
        applicationId: input.applicationId,
        status: "failed",
        prefilledData: null,
        logs,
      });
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
}
