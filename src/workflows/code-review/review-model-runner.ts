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

export const REVIEW_MODEL_PROMPT_TIMEOUT_MS = 1_200_000;

/** A provider or output failure that is safe to handle by trying another model. */
export class ModelReviewError extends Error {
  constructor(
    public readonly modelLabel: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModelReviewError';
  }
}

/** Every configured model failed; the durable Workflow should not replay the chain. */
export class AllModelsFailedError extends Error {
  constructor(public readonly failures: ModelReviewError[]) {
    super(
      failures.length > 0
        ? `All LLM providers failed for code review: ${failures.map((failure) => failure.message).join('; ')}`
        : 'All LLM providers failed for code review',
    );
    this.name = 'AllModelsFailedError';
  }
}

interface ReviewModelRunnerInput {
  flue: FlueRuntime;
  prompt: string;
  promptErrorHint: string;
  models: ModelConfig[];
  activePreviousComments: PreviousComment[];
  severityOverrides?: Record<string, 'critical' | 'suggestion' | 'low'>;
  patternWeights?: Map<string, PatternWeight>;
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
): Promise<ReviewResult> {
  const modelLabel = `${model.providerID}/${model.modelID}`;
  let response = '';

  try {
    response = await withTimeout(
      flue.client.prompt(prompt, { model, result: v.string() }),
      REVIEW_MODEL_PROMPT_TIMEOUT_MS,
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
    response = await withTimeout(
      flue.client.prompt(retryPrompt, { model, result: v.string() }),
      REVIEW_MODEL_PROMPT_TIMEOUT_MS,
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
}: ReviewModelRunnerInput): Promise<ReviewResult> {
  const failures: ModelReviewError[] = [];

  for (const model of models) {
    try {
      return await promptForModel(
        flue,
        prompt,
        promptErrorHint,
        model,
        activePreviousComments,
        severityOverrides,
        patternWeights,
      );
    } catch (error) {
      if (!(error instanceof ModelReviewError)) {
        throw error;
      }

      failures.push(error);
      console.warn('[code-review] model failed, will fallback', {
        model: error.modelLabel,
        error: error.message,
        willFallback: failures.length < models.length,
      });
    }
  }

  throw new AllModelsFailedError(failures);
}
