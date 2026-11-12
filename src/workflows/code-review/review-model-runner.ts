import * as v from 'valibot';
import type { FlueRuntime } from '@flue/cloudflare';

import type { PatternWeight, PreviousComment, ReviewResult } from './types';
import {
  extractJsonFromResponse,
  extractRawFlueResponse,
  formatPromptError,
  safeJsonParse,
  withTimeout,
} from './utils';
import {
  normalizeReviewResult,
  validateReviewResult,
} from './processor-utils';
import type { ModelConfig } from '../../lib/llm-providers';

// Must stay well below the run-llm-review step timeout: when this equals/exceeds
// it, the step dies before a timed-out model can fall back to the next one and
// the durable retry just replays the same hang (observed 3x20min on PR 4002).
// 10min/prompt x 3 models fits the 40min step; format-retry worst case can
// still exceed — accepted, timeouts are the observed failure mode. DeepSeek via
// the AI Gateway needs >6min on real review prompts (observed rms#4050, 2026-09-24).
export const REVIEW_MODEL_PROMPT_TIMEOUT_MS = 600_000;

/** Default end-to-end budget for one review's whole model chain (plan 004-U2).
 * Fits inside the 40-minute run-llm-review step while leaving headroom for
 * publish; configurable via REVIEW_TOTAL_BUDGET_MS. */
export const DEFAULT_REVIEW_TOTAL_BUDGET_MS = 35 * 60_000;

/** A prompt is only worth starting with at least this much budget left. */
export const MIN_PROMPT_BUDGET_MS = 60_000;

/** Tail of the budget reserved for cancellation + honest failure reporting. */
export const REVIEW_BUDGET_CLEANUP_RESERVE_MS = 30_000;

/** A provider or output failure that is safe to handle by trying another model. */
export class ModelReviewError extends Error {
  public readonly modelLabel: string;

  constructor(modelLabel: string, message: string) {
    super(message);
    this.name = 'ModelReviewError';
    this.modelLabel = modelLabel;
  }
}

/** Every configured model failed; the durable Workflow should not replay the chain. */
export class AllModelsFailedError extends Error {
  public readonly failures: ModelReviewError[];

  constructor(failures: ModelReviewError[]) {
    super(
      failures.length > 0
        ? `All LLM providers failed for code review: ${failures.map((failure) => failure.message).join('; ')}`
        : 'All LLM providers failed for code review',
    );
    this.name = 'AllModelsFailedError';
    this.failures = failures;
  }

  /** True when at least one failure was sandbox/DO infrastructure trouble, not a model problem. */
  hasTransientSandboxFailures(): boolean {
    return this.failures.some((failure) => isTransientSandboxFailure(failure.message));
  }
}

const TRANSIENT_SANDBOX_FAILURE_PATTERNS = [
  // Sandbox DO was reset/evicted mid-review (e.g. PR rms#4008: every model
  // failed instantly with this, then the review died as non-retryable).
  'no longer active',
  // Container/agent never booted (observed as all-provider 360s timeouts).
  'failed to start',
  'empty polls',
  // OpenCode server wedged after a timed-out prompt kills subsequent session
  // creations (observed rms#4050: gateway timeout, then glm+openai both died
  // with this). A retry replays on a fresh sandbox and recovers.
  'Failed to create OpenCode session',
];

/** Whether an error message looks like transient sandbox infrastructure trouble. */
export function isTransientSandboxFailure(message: string): boolean {
  return TRANSIENT_SANDBOX_FAILURE_PATTERNS.some((pattern) => message.includes(pattern));
}

interface ReviewModelRunnerInput {
  flue: FlueRuntime;
  prompt: string;
  promptErrorHint: string;
  models: ModelConfig[];
  activePreviousComments: PreviousComment[];
  severityOverrides?: Record<string, 'critical' | 'suggestion' | 'low'>;
  patternWeights?: Map<string, PatternWeight>;
  /** Absolute epoch-ms deadline for the whole chain (plan 004-U2). */
  deadlineMs?: number;
}

/** Per-call timeout clamped to the remaining run budget; throws when the run
 * is out of budget so the caller surfaces an honest failure instead of
 * starting a call that cannot finish (plan 004-U2). */
function resolveCallTimeoutMs(modelLabel: string, deadlineMs?: number): number {
  if (!deadlineMs) return REVIEW_MODEL_PROMPT_TIMEOUT_MS;
  const remaining = deadlineMs - Date.now() - REVIEW_BUDGET_CLEANUP_RESERVE_MS;
  if (remaining < MIN_PROMPT_BUDGET_MS) {
    throw new ModelReviewError(
      modelLabel,
      `review budget exhausted before ${modelLabel}: only ${Math.max(0, remaining)}ms left of the run budget`
    );
  }
  return Math.min(REVIEW_MODEL_PROMPT_TIMEOUT_MS, remaining);
}

function parseValidatedReview(response: string):
  | { result: ReviewResult }
  | { reason: string } {
  try {
    const parsed = safeJsonParse<ReviewResult>(response);
    const validation = validateReviewResult(parsed);
    if (validation.valid) {
      return { result: parsed };
    }
    return { reason: validation.reason ?? 'invalid review output' };
  } catch (error) {
    return {
      reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function promptForModel(
  flue: FlueRuntime,
  prompt: string,
  promptErrorHint: string,
  model: ModelConfig,
  activePreviousComments: PreviousComment[],
  severityOverrides: Record<string, 'critical' | 'suggestion' | 'low'> | undefined,
  patternWeights: Map<string, PatternWeight> | undefined,
  deadlineMs?: number,
): Promise<ReviewResult> {
  const modelLabel = `${model.providerID}/${model.modelID}`;
  let response = '';

  try {
    // Resolve the timeout BEFORE creating the prompt promise: evaluating it
    // as an argument would launch the call first and only then discover the
    // budget is gone.
    const initialTimeoutMs = resolveCallTimeoutMs(modelLabel, deadlineMs);
    response = await withTimeout(
      flue.client.prompt(prompt, { model, result: v.string() }),
      initialTimeoutMs,
      `LLM prompt timed out after ${REVIEW_MODEL_PROMPT_TIMEOUT_MS / 1000}s (${modelLabel})`,
    );
  } catch (error) {
    const rawResponse = extractRawFlueResponse(error);
    if (rawResponse) {
      const recovered = parseValidatedReview(extractJsonFromResponse(rawResponse));
      if ('result' in recovered) {
        return normalizeReviewResult(
          recovered.result,
          activePreviousComments,
          severityOverrides,
          patternWeights,
        );
      }
      response = rawResponse;
    }
    if (!response) {
      throw new ModelReviewError(modelLabel, formatPromptError(error, modelLabel));
    }
  }

  let validation = parseValidatedReview(response);
  if ('result' in validation) {
    return normalizeReviewResult(
      validation.result,
      activePreviousComments,
      severityOverrides,
      patternWeights,
    );
  }

  const retryPrompt = `${prompt}\n\n${promptErrorHint}\nReason: ${validation.reason}`;
  try {
    const retryTimeoutMs = resolveCallTimeoutMs(modelLabel, deadlineMs);
    response = await withTimeout(
      flue.client.prompt(retryPrompt, { model, result: v.string() }),
      retryTimeoutMs,
      `LLM prompt timed out after ${REVIEW_MODEL_PROMPT_TIMEOUT_MS / 1000}s (${modelLabel})`,
    );
  } catch (error) {
    const rawResponse = extractRawFlueResponse(error);
    if (rawResponse) {
      const recovered = parseValidatedReview(extractJsonFromResponse(rawResponse));
      if ('result' in recovered) {
        return normalizeReviewResult(
          recovered.result,
          activePreviousComments,
          severityOverrides,
          patternWeights,
        );
      }
      response = rawResponse;
    }
    if (!response) {
      throw new ModelReviewError(modelLabel, formatPromptError(error, modelLabel));
    }
  }

  validation = parseValidatedReview(response);
  if ('result' in validation) {
    return normalizeReviewResult(
      validation.result,
      activePreviousComments,
      severityOverrides,
      patternWeights,
    );
  }

  throw new ModelReviewError(
    modelLabel,
    `Invalid review output after retry (${modelLabel}): ${validation.reason}`,
  );
}

/**
 * Run the quality-preserving model chain.
 *
 * Each model gets one format-correcting retry. Once every model has produced a
 * provider/output failure, the caller receives AllModelsFailedError so the
 * durable Workflow can fail without replaying the same exhausted chain.
 */
export async function runReviewModels({
  flue,
  prompt,
  promptErrorHint,
  models,
  activePreviousComments,
  severityOverrides,
  patternWeights,
  deadlineMs,
}: ReviewModelRunnerInput): Promise<ReviewResult> {
  const failures: ModelReviewError[] = [];

  for (const model of models) {
    const attemptStartedAt = Date.now();
    try {
      const result = await promptForModel(
        flue,
        prompt,
        promptErrorHint,
        model,
        activePreviousComments,
        severityOverrides,
        patternWeights,
        deadlineMs,
      );
      // Structured attempt telemetry (plan 001-U3): model label, outcome and
      // wall time only — no prompt content, no credentials.
      console.log(
        '[review-metrics]',
        JSON.stringify({
          event: 'model-attempt',
          model: `${model.providerID}/${model.modelID}`,
          attempt: failures.length + 1,
          outcome: 'ok',
          durationMs: Date.now() - attemptStartedAt,
        })
      );
      return result;
    } catch (error) {
      if (!(error instanceof ModelReviewError)) {
        throw error;
      }

      failures.push(error);
      console.warn(
        '[review-metrics]',
        JSON.stringify({
          event: 'model-attempt',
          model: error.modelLabel,
          attempt: failures.length,
          outcome: 'failed',
          durationMs: Date.now() - attemptStartedAt,
          reason: error.message.slice(0, 200),
          willFallback: failures.length < models.length,
        })
      );
      console.warn('[code-review] model failed, will fallback', {
        model: error.modelLabel,
        error: error.message,
        willFallback: failures.length < models.length,
      });
    }
  }

  throw new AllModelsFailedError(failures);
}
