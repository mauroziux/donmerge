import { describe, expect, it, vi } from 'vitest';
import type { FlueRuntime } from '@flue/cloudflare';

import {
  AllModelsFailedError,
  runReviewModels,
} from '../review-model-runner';

const validReview = JSON.stringify({
  summary: 'Review completed.',
  prSummary: {
    overview: 'The change is coherent.',
    keyChanges: ['Updated the implementation'],
    codeQuality: 'Good',
    testingNotes: 'Tests are covered.',
    riskAssessment: 'Low risk.',
  },
  lineComments: [],
  criticalIssues: [],
  suggestions: [],
});

function runnerInput(prompt: FlueRuntime['client']['prompt']) {
  return {
    flue: { client: { prompt } } as unknown as FlueRuntime,
    prompt: 'Review this diff.',
    promptErrorHint: 'Return valid JSON.',
    models: [
      { providerID: 'kimi', modelID: 'k3' },
      { providerID: 'openai', modelID: 'gpt-4o' },
    ],
    activePreviousComments: [],
  };
}

describe('review-model-runner', () => {
  it('uses one format repair before accepting a quality-valid result', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(validReview);

    const result = await runReviewModels(runnerInput(prompt));

    expect(result.summary).toBe('Review completed.');
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1]?.[0]).toContain('Return valid JSON.');
  });

  it('falls back from a gateway/provider failure to the next model', async () => {
    const prompt = vi.fn()
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce(validReview);
    const input = runnerInput(prompt);
    input.models = [
      { providerID: 'aigateway', modelID: 'dynamic/review' },
      { providerID: 'glm', modelID: '5.2' },
    ];

    const result = await runReviewModels(input);

    expect(result.summary).toBe('Review completed.');
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('does not replay exhausted models after the repair attempt', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{}')
      .mockRejectedValueOnce(new Error('provider timeout'));

    await expect(runReviewModels(runnerInput(prompt))).rejects.toBeInstanceOf(AllModelsFailedError);

    // First model: initial + one repair. Second model: one provider failure.
    expect(prompt).toHaveBeenCalledTimes(3);
  });
});
