/**
 * Tests for the code-review queue consumer (src/queues/code-review-consumer.ts).
 *
 * Verifies the per-message contract:
 *   - processGitHubCodeReviewWebhook succeeds → msg.ack() called
 *   - processGitHubCodeReviewWebhook throws  → msg.retry({ delaySeconds: 30 }) called
 *   - multiple messages in a batch are handled independently (one failure
 *     doesn't poison the rest)
 *
 * processGitHubCodeReviewWebhook is mocked via vi.mock so no real DO/Workflow
 * bindings are exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the webhook pipeline — only the consumer's success/throw contract matters.
vi.mock('../../workflows/code-review/webhook', () => ({
  processGitHubCodeReviewWebhook: vi.fn(),
}));

import { handleCodeReviewQueue } from '../code-review-consumer';
import { processGitHubCodeReviewWebhook } from '../../workflows/code-review/webhook';
import type { WebhookContext } from '../../workflows/code-review/types';

const mockedProcess = vi.mocked(processGitHubCodeReviewWebhook);

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeMessage(body: WebhookContext, overrides: Partial<{ id: string; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> = {}) {
  return {
    id: overrides.id ?? 'msg-1',
    timestamp: Date.now(),
    body,
    ack: overrides.ack ?? vi.fn(),
    retry: overrides.retry ?? vi.fn(),
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]) {
  return { messages, queue: 'code-review-jobs' };
}

const baseContext: WebhookContext = {
  owner: 'tableoltd',
  repo: 'test-repo',
  prNumber: 42,
  retrigger: false,
  installationId: 123456,
};

const baseEnv = {
  OPENAI_API_KEY: 'test-key',
  GITHUB_WEBHOOK_SECRET: 'secret',
  ReviewProcessor: {} as DurableObjectNamespace,
} as never; // EnvWithQueue — only the fields processGitHubCodeReviewWebhook reads matter (it's mocked)

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handleCodeReviewQueue', () => {
  it('acks a message when processGitHubCodeReviewWebhook succeeds', async () => {
    mockedProcess.mockResolvedValue(undefined);
    const ack = vi.fn();
    const retry = vi.fn();
    const msg = makeMessage(baseContext, { ack, retry });
    const batch = makeBatch([msg]);

    await handleCodeReviewQueue(batch as never, baseEnv);

    expect(mockedProcess).toHaveBeenCalledWith(baseEnv, baseContext);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries with delaySeconds=30 when processGitHubCodeReviewWebhook throws', async () => {
    mockedProcess.mockRejectedValue(new Error('workflow create failed: 8000007'));
    const ack = vi.fn();
    const retry = vi.fn();
    const msg = makeMessage(baseContext, { ack, retry });
    const batch = makeBatch([msg]);

    await handleCodeReviewQueue(batch as never, baseEnv);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('logs the message id and context on failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedProcess.mockRejectedValue(new Error('boom'));
    const msg = makeMessage(baseContext, { id: 'msg-fail-1' });
    const batch = makeBatch([msg]);

    await handleCodeReviewQueue(batch as never, baseEnv);

    expect(errSpy).toHaveBeenCalledWith(
      'code-review-jobs: message failed',
      expect.objectContaining({
        messageId: 'msg-fail-1',
        owner: 'tableoltd',
        repo: 'test-repo',
        prNumber: 42,
        error: 'boom',
      })
    );
  });

  it('handles a non-Error throw by stringifying it', async () => {
    mockedProcess.mockRejectedValue('string error');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const msg = makeMessage(baseContext);
    const batch = makeBatch([msg]);

    await handleCodeReviewQueue(batch as never, baseEnv);

    expect(errSpy).toHaveBeenCalledWith(
      'code-review-jobs: message failed',
      expect.objectContaining({ error: 'string error' })
    );
  });

  it('processes a mixed batch independently (one success, one failure)', async () => {
    const ctxA: WebhookContext = { ...baseContext, prNumber: 1 };
    const ctxB: WebhookContext = { ...baseContext, prNumber: 2 };

    mockedProcess
      .mockResolvedValueOnce(undefined) // ctxA succeeds
      .mockRejectedValueOnce(new Error('fail')); // ctxB fails

    const ackA = vi.fn();
    const retryA = vi.fn();
    const ackB = vi.fn();
    const retryB = vi.fn();

    const batch = makeBatch([
      makeMessage(ctxA, { id: 'a', ack: ackA, retry: retryA }),
      makeMessage(ctxB, { id: 'b', ack: ackB, retry: retryB }),
    ]);

    await handleCodeReviewQueue(batch as never, baseEnv);

    expect(ackA).toHaveBeenCalledTimes(1);
    expect(retryA).not.toHaveBeenCalled();
    expect(ackB).not.toHaveBeenCalled();
    expect(retryB).toHaveBeenCalledWith({ delaySeconds: 30 });

    expect(mockedProcess).toHaveBeenCalledTimes(2);
  });

  it('handles an empty batch without calling processGitHubCodeReviewWebhook', async () => {
    const batch = makeBatch([]);
    await handleCodeReviewQueue(batch as never, baseEnv);
    expect(mockedProcess).not.toHaveBeenCalled();
  });

  describe('already_exists recovery', () => {
    it('restarts the existing workflow instance on already_exists error', async () => {
      mockedProcess.mockRejectedValue(
        new Error('(instance.already_exists) Instance already exists')
      );

      const restart = vi.fn().mockResolvedValue(undefined);
      const getSpy = vi.fn().mockResolvedValue({ restart });
      const envWithWorkflow = {
        ...(baseEnv as unknown as Record<string, unknown>),
        CODE_REVIEW_WORKFLOW: { get: getSpy } as unknown as Workflow,
      } as never;

      const ack = vi.fn();
      const retry = vi.fn();
      const msg = makeMessage(baseContext, { ack, retry });
      const batch = makeBatch([msg]);

      await handleCodeReviewQueue(batch as never, envWithWorkflow);

      expect(getSpy).toHaveBeenCalledWith('review-tableoltd-test-repo-42');
      expect(restart).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    });

    it('retries with delaySeconds=30 when restart itself fails', async () => {
      mockedProcess.mockRejectedValue(
        new Error('(instance.already_exists) Instance already exists')
      );

      const restart = vi.fn().mockRejectedValue(new Error('restart blew up'));
      const getSpy = vi.fn().mockResolvedValue({ restart });
      const envWithWorkflow = {
        ...(baseEnv as unknown as Record<string, unknown>),
        CODE_REVIEW_WORKFLOW: { get: getSpy } as unknown as Workflow,
      } as never;

      const ack = vi.fn();
      const retry = vi.fn();
      const msg = makeMessage(baseContext, { ack, retry });
      const batch = makeBatch([msg]);

      await handleCodeReviewQueue(batch as never, envWithWorkflow);

      expect(restart).toHaveBeenCalledTimes(1);
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    });
  });
});
