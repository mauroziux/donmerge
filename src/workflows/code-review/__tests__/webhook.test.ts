/**
 * Tests for webhook.ts - validateWebhookFast flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock the imports before importing webhook
vi.mock('../github-auth', () => ({
  verifyWebhookSignature: vi.fn(),
  isRepoAllowed: vi.fn(),
}));

vi.mock('../triggers', () => ({
  parseTrigger: vi.fn(),
}));

vi.mock('../github-api', () => ({
  githubFetch: vi.fn(),
  createCheckRun: vi.fn(),
}));

vi.mock('../processor', () => ({
  getReviewProcessor: vi.fn(),
}));

import { validateWebhookFast } from '../webhook';
import { verifyWebhookSignature, isRepoAllowed } from '../github-auth';
import { parseTrigger } from '../triggers';

const mockedVerify = vi.mocked(verifyWebhookSignature);
const mockedIsAllowed = vi.mocked(isRepoAllowed);
const mockedParseTrigger = vi.mocked(parseTrigger);

const baseEnv = {
  OPENAI_API_KEY: 'test-key',
  GITHUB_WEBHOOK_SECRET: 'secret123',
  REPO_CONFIGS: 'tableoltd/test-repo:main',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateWebhookFast', () => {
  it('should reject with 401 when signature is invalid', async () => {
    mockedVerify.mockResolvedValue(false);

    const result = await validateWebhookFast(
      { ...baseEnv },
      'push',
      'sha256=invalid',
      '{"action":"opened"}'
    );

    expect(result.shouldProcess).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'invalid signature' });
  });

  it('should reject with 400 when repository context is missing', async () => {
    mockedVerify.mockResolvedValue(true);

    const result = await validateWebhookFast(
      { ...baseEnv },
      'push',
      'sha256=abc',
      '{"action":"opened"}'
    );

    expect(result.shouldProcess).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'missing repository context' });
  });

  it('should reject with 403 when repository is not allowed', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(false);

    const result = await validateWebhookFast(
      { ...baseEnv },
      'pull_request',
      'sha256=abc',
      JSON.stringify({
        action: 'opened',
        installation: { id: 123 },
        repository: { owner: { login: 'evil' }, name: 'repo' },
        pull_request: { number: 1 },
      })
    );

    expect(result.shouldProcess).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'repository not allowed',
      repository: 'evil/repo',
    });
  });

  it('should skip with 200 when trigger says do not run', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: false,
      prNumber: 0,
      retrigger: false,
      reason: 'ignored pull_request action',
    });

    const result = await validateWebhookFast(
      { ...baseEnv },
      'pull_request',
      'sha256=abc',
      JSON.stringify({
        action: 'closed',
        installation: { id: 123 },
        repository: { owner: { login: 'tableoltd' }, name: 'test-repo' },
        pull_request: { number: 1 },
      })
    );

    expect(result.shouldProcess).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      skipped: true,
      reason: 'ignored pull_request action',
    });
  });

  it('should accept with 202 and context when trigger fires', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: true,
      prNumber: 42,
      retrigger: false,
    });

    const result = await validateWebhookFast(
      { ...baseEnv },
      'pull_request',
      'sha256=abc',
      JSON.stringify({
        action: 'opened',
        installation: { id: 123456 },
        repository: { owner: { login: 'tableoltd' }, name: 'test-repo' },
        pull_request: { number: 42 },
      })
    );

    expect(result.shouldProcess).toBe(true);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, accepted: true });
    expect(result.context).toEqual({
      owner: 'tableoltd',
      repo: 'test-repo',
      prNumber: 42,
      retrigger: false,
      installationId: 123456,
      commentId: undefined,
      commentType: undefined,
      instruction: undefined,
      focusFiles: undefined,
    });
  });

  it('should pass through retrigger, commentId, commentType, instruction, focusFiles', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: true,
      prNumber: 42,
      retrigger: true,
      commentId: 99,
      commentType: 'issue',
      instruction: 'focus on security',
      focusFiles: ['src/auth.ts'],
    });

    const result = await validateWebhookFast(
      { ...baseEnv },
      'issue_comment',
      'sha256=abc',
      JSON.stringify({
        action: 'created',
        installation: { id: 123 },
        repository: { owner: { login: 'tableoltd' }, name: 'test-repo' },
        issue: { number: 42, pull_request: {} },
        comment: { body: '@donmerge review', id: 99 },
      })
    );

    expect(result.shouldProcess).toBe(true);
    expect(result.context?.retrigger).toBe(true);
    expect(result.context?.commentId).toBe(99);
    expect(result.context?.commentType).toBe('issue');
    expect(result.context?.instruction).toBe('focus on security');
    expect(result.context?.focusFiles).toEqual(['src/auth.ts']);
  });

  it('should pass custom REVIEW_TRIGGER to parseTrigger', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: false,
      prNumber: 0,
      retrigger: false,
      reason: 'unsupported event: push',
    });

    await validateWebhookFast(
      { ...baseEnv, REVIEW_TRIGGER: '@mybot' },
      'push',
      'sha256=abc',
      JSON.stringify({
        repository: { owner: { login: 'tableoltd' }, name: 'test-repo' },
      })
    );

    expect(mockedParseTrigger).toHaveBeenCalledWith('push', expect.any(Object), '@mybot');
  });
});
