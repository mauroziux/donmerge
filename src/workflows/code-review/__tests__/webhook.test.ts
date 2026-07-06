/**
 * Tests for webhook.ts - validateWebhookFast and processGitHubCodeReviewWebhook flows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock the imports before importing webhook
vi.mock('../github-auth', () => ({
  verifyWebhookSignature: vi.fn(),
  isRepoAllowed: vi.fn(),
  resolveGitHubToken: vi.fn(),
}));

vi.mock('../triggers', () => ({
  parseTrigger: vi.fn(),
}));

vi.mock('../github-api', () => ({
  githubFetch: vi.fn(),
  createCheckRun: vi.fn(),
  fetchCommentById: vi.fn(),
}));

vi.mock('../processor', () => ({
  getReviewProcessor: vi.fn(),
}));

vi.mock('../fingerprint', () => ({
  parseFingerprint: vi.fn(),
}));

vi.mock('../feedback-handler', () => ({
  handleCommentFeedback: vi.fn(),
  handleReactionFeedback: vi.fn(),
}));

import { validateWebhookFast, processGitHubCodeReviewWebhook } from '../webhook';
import {
  verifyWebhookSignature,
  isRepoAllowed,
  resolveGitHubToken,
} from '../github-auth';
import { parseTrigger } from '../triggers';
import { fetchCommentById } from '../github-api';
import { parseFingerprint } from '../fingerprint';
import {
  handleCommentFeedback,
  handleReactionFeedback,
} from '../feedback-handler';
import type { WorkerEnv, WebhookContext } from '../types';

type EnvWithReviewProcessor = WorkerEnv & {
  ReviewProcessor: DurableObjectNamespace;
  CODE_REVIEW_WORKFLOW?: Workflow;
};

const mockedVerify = vi.mocked(verifyWebhookSignature);
const mockedIsAllowed = vi.mocked(isRepoAllowed);
const mockedParseTrigger = vi.mocked(parseTrigger);
const mockedResolveToken = vi.mocked(resolveGitHubToken);
const mockedFetchComment = vi.mocked(fetchCommentById);
const mockedParseFingerprint = vi.mocked(parseFingerprint);
const mockedHandleCommentFeedback = vi.mocked(handleCommentFeedback);
const mockedHandleReactionFeedback = vi.mocked(handleReactionFeedback);

const baseEnv: WorkerEnv = {
  OPENAI_API_KEY: 'test-key',
  GITHUB_WEBHOOK_SECRET: 'secret123',
  REPO_CONFIGS: 'tableoltd/test-repo:main',
  Sandbox: {},
};

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

// ── MAJOR 2: validateWebhookFast feedback path ────────────────────────────────

describe('validateWebhookFast feedback path', () => {
  const feedbackPayload = JSON.stringify({
    action: 'created',
    installation: { id: 123 },
    repository: { owner: { login: 'tableoltd' }, name: 'test-repo' },
    issue: { number: 42, pull_request: {} },
    comment: { body: '@donmerge dismiss abc123', id: 99, user: { login: 'dev' } },
  });

  it('should return shouldProcess: true, status: 202 with feedback when parseTrigger has feedback', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: false,
      prNumber: 42,
      retrigger: false,
      feedback: { type: 'dismiss', fingerprint: 'abc123' },
      commentId: 99,
      commentType: 'issue',
      githubUser: 'dev',
      inReplyToId: undefined,
      reason: 'feedback command',
    });

    const result = await validateWebhookFast(
      { ...baseEnv },
      'issue_comment',
      'sha256=abc',
      feedbackPayload
    );

    expect(result.shouldProcess).toBe(true);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, accepted: true, feedback: true });
    expect(result.context).toBeDefined();
    expect(result.context!.feedback).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
    expect(result.context!.owner).toBe('tableoltd');
    expect(result.context!.repo).toBe('test-repo');
    expect(result.context!.prNumber).toBe(42);
    expect(result.context!.commentId).toBe(99);
    expect(result.context!.commentType).toBe('issue');
    expect(result.context!.githubUser).toBe('dev');
  });

  it('should include feedback in context even when shouldRun is false', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: false,
      prNumber: 10,
      retrigger: false,
      feedback: { type: 'accept', fingerprint: 'xyz789' },
      commentId: 55,
      commentType: 'review',
      githubUser: 'reviewer',
      inReplyToId: 44,
      reason: 'feedback command',
    });

    const result = await validateWebhookFast(
      { ...baseEnv },
      'pull_request_review_comment',
      'sha256=abc',
      JSON.stringify({
        action: 'created',
        installation: { id: 123 },
        repository: { owner: { login: 'tableoltd' }, name: 'test-repo' },
        pull_request: { number: 10 },
        comment: { body: '@donmerge accept xyz789', id: 55, user: { login: 'reviewer' } },
      })
    );

    expect(result.shouldProcess).toBe(true);
    expect(result.status).toBe(202);
    expect(result.context!.feedback).toEqual({ type: 'accept', fingerprint: 'xyz789' });
    expect(result.context!.prNumber).toBe(10);
    expect(result.context!.commentId).toBe(55);
    expect(result.context!.commentType).toBe('review');
    expect(result.context!.githubUser).toBe('reviewer');
    expect(result.context!.inReplyToId).toBe(44);
  });
});

// ── MAJOR 3: processGitHubCodeReviewWebhook feedback branch ───────────────────

describe('processGitHubCodeReviewWebhook feedback branch', () => {
  const mockDb = {} as D1Database;
  const mockEnv: EnvWithReviewProcessor = {
    OPENAI_API_KEY: 'test-key',
    GITHUB_WEBHOOK_SECRET: 'secret123',
    REPO_CONFIGS: 'tableoltd/test-repo:main',
    Sandbox: {},
    DB: mockDb,
    ReviewProcessor: {} as DurableObjectNamespace,
  };

  const baseContext: WebhookContext = {
    owner: 'tableoltd',
    repo: 'test-repo',
    prNumber: 42,
    retrigger: false,
    installationId: 123,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call handleCommentFeedback for dismiss with fingerprint', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss', fingerprint: 'abc123' },
      commentId: 99,
      commentType: 'issue',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).toHaveBeenCalledWith(mockDb, {
      owner: 'tableoltd',
      repo: 'test-repo',
      prNumber: 42,
      githubUser: 'dev',
      commentBody: '@donmerge dismiss abc123',
      commentId: 99,
      inReplyToId: 88,
    });
    expect(mockedHandleReactionFeedback).not.toHaveBeenCalled();
  });

  it('should call handleCommentFeedback for accept with fingerprint', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'accept', fingerprint: 'xyz789' },
      commentId: 55,
      commentType: 'review',
      githubUser: 'reviewer',
    });

    expect(mockedHandleCommentFeedback).toHaveBeenCalledWith(mockDb, {
      owner: 'tableoltd',
      repo: 'test-repo',
      prNumber: 42,
      githubUser: 'reviewer',
      commentBody: '@donmerge accept xyz789',
      commentId: 55,
      inReplyToId: undefined,
    });
  });

  it('should call handleCommentFeedback for preference with text', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'preference', text: 'Focus on: src/auth.ts' },
      commentId: 77,
      githubUser: 'contributor',
    });

    expect(mockedHandleCommentFeedback).toHaveBeenCalledWith(mockDb, {
      owner: 'tableoltd',
      repo: 'test-repo',
      prNumber: 42,
      githubUser: 'contributor',
      commentBody: '@donmerge preference Focus on: src/auth.ts',
      commentId: 77,
    });
  });

  it('should warn and return when env.DB is undefined', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const envNoDb = { ...mockEnv, DB: undefined } as unknown as EnvWithReviewProcessor;

    await processGitHubCodeReviewWebhook(envNoDb, {
      ...baseContext,
      feedback: { type: 'dismiss', fingerprint: 'abc123' },
    });

    expect(warnSpy).toHaveBeenCalledWith('DB not bound — feedback not stored');
    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(mockedHandleReactionFeedback).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should call handleReactionFeedback for reaction feedback (no fingerprint)', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      body: 'Some comment body <!-- DONMERGE_META: {"ruleId":"no-bug"} -->',
      id: 30,
      in_reply_to_id: null,
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fingerprint_from_comment' } as any);
    mockedHandleReactionFeedback.mockResolvedValue(true);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss' },
      commentId: 30,
      commentType: 'review',
      githubUser: 'dev',
    });

    expect(mockedResolveToken).toHaveBeenCalledWith(mockEnv, 123);
    expect(mockedFetchComment).toHaveBeenCalledWith(
      'tableoltd',
      'test-repo',
      30,
      'ghp_test_token',
      'review'
    );
    expect(mockedParseFingerprint).toHaveBeenCalledWith(
      'Some comment body <!-- DONMERGE_META: {"ruleId":"no-bug"} -->'
    );
    expect(mockedHandleReactionFeedback).toHaveBeenCalledWith(mockDb, {
      owner: 'tableoltd',
      repo: 'test-repo',
      prNumber: 42,
      githubUser: 'dev',
      reaction: 'thumbsdown',
      commentId: 30,
      commentFingerprint: 'fingerprint_from_comment',
    });
    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
  });
});
