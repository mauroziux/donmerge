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
  addCommentReaction: vi.fn(),
  postReplyComment: vi.fn(),
  isDonmergeBotAuthor: vi.fn((user?: { login?: string; type?: string } | null) =>
    user?.type === 'Bot' && user.login?.toLowerCase() === 'donmerge[bot]'),
}));

vi.mock('../reply-classifier', () => ({
  classifyCommandIntent: vi.fn().mockResolvedValue('directive'),
  classifyReply: vi.fn().mockResolvedValue(null),
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
  handleNaturalReply: vi.fn(),
}));

import { validateWebhookFast, processGitHubCodeReviewWebhook } from '../webhook';
import {
  verifyWebhookSignature,
  isRepoAllowed,
  resolveGitHubToken,
} from '../github-auth';
import { parseTrigger } from '../triggers';
import { getReviewProcessor } from '../processor';
import { fetchCommentById, addCommentReaction, postReplyComment } from '../github-api';
import { classifyCommandIntent } from '../reply-classifier';
import { parseFingerprint } from '../fingerprint';
import {
  handleCommentFeedback,
  handleReactionFeedback,
  handleNaturalReply,
} from '../feedback-handler';
import type { WorkerEnv, WebhookContext } from '../types';

type EnvWithReviewProcessor = WorkerEnv & {
  ReviewProcessor: DurableObjectNamespace;
  CODE_REVIEW_WORKFLOW?: Workflow;
};

const mockedVerify = vi.mocked(verifyWebhookSignature);
const mockedIsAllowed = vi.mocked(isRepoAllowed);
const mockedParseTrigger = vi.mocked(parseTrigger);
const mockedGetReviewProcessor = vi.mocked(getReviewProcessor);
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

  it('propagates the original command body to the feedback context for the intent gate', async () => {
    mockedVerify.mockResolvedValue(true);
    mockedIsAllowed.mockReturnValue(true);
    mockedParseTrigger.mockReturnValue({
      shouldRun: false,
      prNumber: 42,
      retrigger: false,
      feedback: { type: 'dismiss' },
      commentId: 99,
      commentType: 'review',
      commentBody: '@donmerge dismiss?',
      githubUser: 'dev',
      inReplyToId: 88,
      reason: 'feedback command',
    });

    const result = await validateWebhookFast(
      { ...baseEnv },
      'pull_request_review_comment',
      'sha256=abc',
      feedbackPayload
    );

    // The gate must classify the human's actual words ('@donmerge dismiss?'),
    // never a reconstructed directive.
    expect(result.context?.commentBody).toBe('@donmerge dismiss?');
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
  const mockDbFirst = vi.fn().mockResolvedValue({ id: 1 });
  const mockDbBind = vi.fn().mockReturnValue({ first: mockDbFirst });
  const mockDb = {
    prepare: vi.fn().mockReturnValue({ bind: mockDbBind }),
  } as unknown as D1Database;
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
    // clearAllMocks keeps stale mockResolvedValue implementations: restore the
    // default directive verdict so per-test overrides start from a clean state.
    vi.mocked(classifyCommandIntent).mockReset();
    vi.mocked(classifyCommandIntent).mockResolvedValue('directive');
  });

  it('should acknowledge an active duplicate without creating a Workflow', async () => {
    const create = vi.fn();
    const startReview = vi.fn().mockResolvedValue({ started: false, reason: 'already_running' });
    mockedGetReviewProcessor.mockReturnValue({ startReview } as never);
    const env = { ...mockEnv, CODE_REVIEW_WORKFLOW: { create } as never };

    await processGitHubCodeReviewWebhook(env, baseContext);

    expect(startReview).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not restart an instance created by the recovery alarm', async () => {
    const create = vi.fn().mockRejectedValue(new Error('already_exists'));
    const get = vi.fn();
    mockedGetReviewProcessor.mockReturnValue({ startReview: vi.fn().mockResolvedValue({ started: true, reason: 'started', runId: 'run-a' }) } as never);
    const env = { ...mockEnv, CODE_REVIEW_WORKFLOW: { create, get } as never };
    await processGitHubCodeReviewWebhook(env, baseContext);
    expect(create).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not start a review when a command-shaped focus trigger is a question', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const startReview = vi.fn().mockResolvedValue({ started: true, reason: 'started' });
    mockedGetReviewProcessor.mockReturnValue({ startReview } as never);
    const env = { ...mockEnv, CODE_REVIEW_WORKFLOW: { create } as never };
    vi.mocked(classifyCommandIntent).mockResolvedValue('question');

    for (const body of [
      '@donmerge focus src/auth.ts?',
      '@donmerge review src/auth.ts?',
      '@donmerge check src/auth.ts?',
      '@donmerge recheck src/auth.ts?',
    ]) {
      await processGitHubCodeReviewWebhook(env, {
        ...baseContext,
        retrigger: true,
        commentId: 99,
        commentType: 'issue',
        commentBody: body,
      });
    }

    expect(vi.mocked(classifyCommandIntent)).toHaveBeenCalledWith(
      expect.anything(),
      '@donmerge focus src/auth.ts?'
    );
    expect(vi.mocked(classifyCommandIntent)).toHaveBeenCalledTimes(4);
    expect(startReview).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('gates a custom-tag review trigger before starting a review', async () => {
    const startReview = vi.fn();
    mockedGetReviewProcessor.mockReturnValue({ startReview } as never);
    vi.mocked(classifyCommandIntent).mockResolvedValue('question');
    const body = '@mybot review ' + 'x'.repeat(1200) + ' is that correct?';
    await processGitHubCodeReviewWebhook({ ...mockEnv, REVIEW_TRIGGER: '@mybot' }, {
      ...baseContext, retrigger: true, commentId: 99, commentType: 'issue', commentBody: body,
    });
    expect(vi.mocked(classifyCommandIntent)).toHaveBeenCalledWith(expect.anything(), body);
    expect(startReview).not.toHaveBeenCalled();
    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
  });

  it('starts the review when a command-shaped trigger reads as a directive', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const startReview = vi.fn().mockResolvedValue({ started: true, reason: 'started' });
    mockedGetReviewProcessor.mockReturnValue({ startReview } as never);
    const env = { ...mockEnv, CODE_REVIEW_WORKFLOW: { create } as never };

    await processGitHubCodeReviewWebhook(env, {
      ...baseContext,
      retrigger: true,
      commentId: 99,
      commentType: 'issue',
      commentBody: '@donmerge review src/auth.ts',
    });

    expect(vi.mocked(classifyCommandIntent)).toHaveBeenCalledWith(
      expect.anything(),
      '@donmerge review src/auth.ts'
    );
    expect(startReview).toHaveBeenCalled();
  });

  it('creates a Workflow when the processor accepts a fresh review', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const startReview = vi.fn().mockResolvedValue({ started: true, reason: 'started' });
    mockedGetReviewProcessor.mockReturnValue({ startReview } as never);
    const env = { ...mockEnv, CODE_REVIEW_WORKFLOW: { create } as never };

    await processGitHubCodeReviewWebhook(env, baseContext);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'review-tableoltd-test-repo-42',
      params: expect.objectContaining({ owner: 'tableoltd', repo: 'test-repo', prNumber: 42 }),
    }));
  });

  it('correlates explicit-fingerprint dismiss commands to recorded parents and acks in-thread', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88,
      body: 'review finding',
      in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'abc123', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss', fingerprint: 'abc123' },
      commentId: 99,
      commentType: 'review',
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
    expect(mockDbBind).toHaveBeenCalledWith('tableoltd', 'test-repo', 88, 'abc123');
    expect(vi.mocked(addCommentReaction)).toHaveBeenCalledWith(
      'tableoltd', 'test-repo', 99, 'review', 'ghp_test_token', 'thumbsup'
    );
    expect(vi.mocked(postReplyComment)).toHaveBeenCalledWith(
      'tableoltd', 'test-repo', 42, 88, 'review', expect.stringContaining('Learned'), 'ghp_test_token'
    );
  });

  it('correlates a bare dismiss reply to its recorded parent and posts both acks', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({ id: 88, body: 'review finding', in_reply_to_id: null, user: { login: 'donmerge[bot]', type: 'Bot' } });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-parent', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss' },
      commentId: 99,
      commentType: 'review',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      commentBody: '@donmerge dismiss fp-parent',
      inReplyToId: 88,
    }));
    expect(vi.mocked(addCommentReaction)).toHaveBeenCalled();
    expect(vi.mocked(postReplyComment)).toHaveBeenCalledWith(
      'tableoltd', 'test-repo', 42, 88, 'review', expect.stringContaining('Learned'), 'ghp_test_token'
    );
  });

  it('rejects explicit fingerprints that do not match the recorded parent', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'review finding', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'actual-fp', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss', fingerprint: 'forged-fp' },
      commentId: 99,
      commentType: 'review',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(vi.mocked(addCommentReaction)).not.toHaveBeenCalled();
  });

  it('rejects copied DonMerge markers not backed by a recorded finding', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'copied marker', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'abc123', version: 1 });
    mockDbFirst.mockResolvedValue(null);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss' },
      commentId: 99,
      commentType: 'review',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(vi.mocked(addCommentReaction)).not.toHaveBeenCalled();
  });

  it('should call handleCommentFeedback for accept with fingerprint', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({ id: 44, body: 'parent', in_reply_to_id: null, user: { login: 'donmerge[bot]', type: 'Bot' } });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'xyz789', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'accept', fingerprint: 'xyz789' },
      commentId: 55,
      commentType: 'review',
      githubUser: 'reviewer',
      inReplyToId: 44,
    });

    expect(mockedHandleCommentFeedback).toHaveBeenCalledWith(mockDb, {
      owner: 'tableoltd',
      repo: 'test-repo',
      prNumber: 42,
      githubUser: 'reviewer',
      commentBody: '@donmerge accept xyz789',
      commentId: 55,
      inReplyToId: 44,
    });
  });

  it('does not store preference commands replying to unrecorded comments', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({ id: 88, body: 'unrelated comment', in_reply_to_id: null });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'copied', version: 1 });
    mockDbFirst.mockResolvedValue(null);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'preference', text: "Don't comment on logging" },
      commentId: 99,
      commentType: 'review',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
  });

  it('stores a preference only when it replies to a verified DonMerge finding', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'review finding', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-preference', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'preference', text: 'Focus on: src/auth.ts' },
      commentId: 77,
      inReplyToId: 88,
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

  it('does not execute a verified dismiss command when the classifier reads it as a question', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'review finding', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'abc123', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });
    vi.mocked(classifyCommandIntent).mockResolvedValue('question');

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'dismiss', fingerprint: 'abc123' },
      commentId: 99,
      commentType: 'review',
      commentBody: '@donmerge dismiss?',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(vi.mocked(classifyCommandIntent)).toHaveBeenCalledWith(
      expect.objectContaining({ OPENAI_API_KEY: 'test-key' }),
      '@donmerge dismiss?'
    );
    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(vi.mocked(addCommentReaction)).not.toHaveBeenCalled();
    expect(vi.mocked(postReplyComment)).not.toHaveBeenCalled();
  });

  it('does not store a preference learning when the classifier reads it as a question', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'review finding', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-pref', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });
    vi.mocked(classifyCommandIntent).mockResolvedValue('question');

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'preference', text: 'should we ignore logging' },
      commentId: 99,
      commentType: 'review',
      commentBody: '@donmerge preference should we ignore logging',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(vi.mocked(addCommentReaction)).not.toHaveBeenCalled();
  });

  it('executes a verified severity override when the intent gate reads a directive', async () => {
    mockedHandleCommentFeedback.mockResolvedValue(true);
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'review finding', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-ovr', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'override', fingerprint: 'fp-ovr', newSeverity: 'suggestion' },
      commentId: 99,
      commentType: 'review',
      commentBody: '@donmerge override fp-ovr suggestion',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(mockedHandleCommentFeedback).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      commentBody: '@donmerge override fp-ovr suggestion',
    }));
    expect(vi.mocked(addCommentReaction)).toHaveBeenCalled();
  });

  it('does not execute a verified override when the intent gate reads a question', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88, body: 'review finding', in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-ovr', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });
    vi.mocked(classifyCommandIntent).mockResolvedValue('question');

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'override', fingerprint: 'fp-ovr', newSeverity: 'suggestion' },
      commentId: 99,
      commentType: 'review',
      commentBody: '@donmerge override fp-ovr suggestion?',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(vi.mocked(classifyCommandIntent)).toHaveBeenCalledWith(
      expect.anything(),
      '@donmerge override fp-ovr suggestion?'
    );
    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(vi.mocked(addCommentReaction)).not.toHaveBeenCalled();
    expect(vi.mocked(postReplyComment)).not.toHaveBeenCalled();
  });

  it('rejects standalone repository-wide preference commands without a verified parent', async () => {
    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      feedback: { type: 'preference', text: 'Focus on security' },
      commentId: 77,
      githubUser: 'contributor',
    });
    expect(mockedHandleCommentFeedback).not.toHaveBeenCalled();
    expect(mockedResolveToken).not.toHaveBeenCalled();
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

  it('processes a natural reply only for a recorded DonMerge parent and acknowledges it', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88,
      body: 'parent review comment',
      in_reply_to_id: null,
      path: 'src/example.ts',
      user: { login: 'donmerge[bot]', type: 'Bot' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-natural', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 2 });
    vi.mocked(handleNaturalReply).mockResolvedValue({
      classification: { type: 'dismiss', reason: 'null checked above', learning: null, source: 'llm' },
      ackBody: '🤖 Learned.',
    } as never);

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      naturalReply: true,
      commentId: 99,
      commentType: 'review',
      commentBody: 'No aplica, el null se valida arriba',
      githubUser: 'dev',
      inReplyToId: 88,
    });

    expect(handleNaturalReply).toHaveBeenCalledWith(mockDb, mockEnv, expect.objectContaining({
      parentFingerprint: 'fp-natural',
      parentBody: 'parent review comment',
      replyText: 'No aplica, el null se valida arriba',
    }));
    expect(vi.mocked(addCommentReaction)).toHaveBeenCalledWith(
      'tableoltd', 'test-repo', 99, 'review', 'ghp_test_token', 'thumbsup'
    );
    expect(vi.mocked(postReplyComment)).toHaveBeenCalledWith(
      'tableoltd', 'test-repo', 42, 88, 'review', '🤖 Learned.', 'ghp_test_token'
    );
  });

  it('does not trust legacy outcome IDs when the fetched parent author is not DonMerge', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedFetchComment.mockResolvedValue({
      id: 88,
      body: '<!-- DONMERGE: {"fingerprint":"fp-forged","version":1} --> copied marker',
      in_reply_to_id: null,
      user: { login: 'contributor', type: 'User' },
    });
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fp-forged', version: 1 });
    // Simulate a pre-existing row with this id/fingerprint: the runtime author check still rejects it.
    mockDbFirst.mockResolvedValue({ id: 1 });

    await processGitHubCodeReviewWebhook(mockEnv, {
      ...baseContext,
      naturalReply: true,
      commentId: 99,
      commentBody: 'No aplica',
      inReplyToId: 88,
    });

    expect(handleNaturalReply).not.toHaveBeenCalled();
    expect(vi.mocked(addCommentReaction)).not.toHaveBeenCalled();
    expect(vi.mocked(postReplyComment)).not.toHaveBeenCalled();
  });

  it('should call handleReactionFeedback for reaction feedback (no fingerprint)', async () => {
    mockedResolveToken.mockResolvedValue('ghp_test_token');
    mockedParseFingerprint.mockReturnValue({ fingerprint: 'fingerprint_from_comment', version: 1 });
    mockDbFirst.mockResolvedValue({ id: 1 });
    mockedFetchComment.mockResolvedValue({
      body: 'Some comment body <!-- DONMERGE_META: {"ruleId":"no-bug"} -->',
      id: 30,
      in_reply_to_id: null,
      user: { login: 'donmerge[bot]', type: 'Bot' },
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
