/**
 * Tests for feedback-handler.ts
 *
 * Covers:
 * - parseDonmergeCommand: @donmerge command parsing
 * - handleCommentFeedback: storing feedback from GitHub comments
 * - handleReactionFeedback: storing feedback from GitHub reactions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseDonmergeCommand,
  handleCommentFeedback,
  handleReactionFeedback,
} from '../feedback-handler';

// ─── D1Database mock factory ────────────────────────────────────────

function createMockDb(overrides: {
  firstResult?: any;
  allResults?: any[];
  runResult?: any;
} = {}) {
  const mockFirst = vi.fn().mockResolvedValue(overrides.firstResult ?? null);
  const mockAll = vi.fn().mockResolvedValue({ results: overrides.allResults ?? [] });
  const mockRun = vi.fn().mockResolvedValue(overrides.runResult ?? {});
  const mockBatch = vi.fn().mockResolvedValue({});

  const mockBind = vi.fn().mockReturnValue({
    first: mockFirst,
    all: mockAll,
    run: mockRun,
  });

  const mockPrepare = vi.fn().mockReturnValue({
    bind: mockBind,
  });

  return {
    db: { prepare: mockPrepare, batch: mockBatch } as unknown as D1Database,
    prepare: mockPrepare,
    bind: mockBind,
    first: mockFirst,
    all: mockAll,
    run: mockRun,
    batch: mockBatch,
  };
}

// ─── parseDonmergeCommand ───────────────────────────────────────────

describe('parseDonmergeCommand', () => {
  it('parses dismiss command', () => {
    const result = parseDonmergeCommand('@donmerge dismiss abc123');
    expect(result).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
  });

  it('parses accept command', () => {
    const result = parseDonmergeCommand('@donmerge accept def456');
    expect(result).toEqual({ type: 'accept', fingerprint: 'def456' });
  });

  it('parses override command with severity', () => {
    const result = parseDonmergeCommand('@donmerge override abc123 suggestion');
    expect(result).toEqual({ type: 'override', fingerprint: 'abc123', newSeverity: 'suggestion' });
  });

  it('parses override command with critical severity', () => {
    const result = parseDonmergeCommand('@donmerge override xyz789 critical');
    expect(result).toEqual({ type: 'override', fingerprint: 'xyz789', newSeverity: 'critical' });
  });

  it('parses override command with low severity', () => {
    const result = parseDonmergeCommand('@donmerge override xyz789 low');
    expect(result).toEqual({ type: 'override', fingerprint: 'xyz789', newSeverity: 'low' });
  });

  it('parses preference command', () => {
    const result = parseDonmergeCommand('@donmerge preference Focus on security');
    expect(result).toEqual({ type: 'preference', text: 'Focus on security' });
  });

  it('parses ignore command as preference', () => {
    const result = parseDonmergeCommand('@donmerge ignore PHPDoc comments');
    expect(result).toEqual({ type: 'preference', text: "Don't comment on: PHPDoc comments" });
  });

  it('parses focus command as preference', () => {
    const result = parseDonmergeCommand('@donmerge focus authentication');
    expect(result).toEqual({ type: 'preference', text: 'Focus on: authentication' });
  });

  it('is case-insensitive for command prefix', () => {
    const result = parseDonmergeCommand('@DonMerge DISMISS abc123');
    expect(result).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
  });

  it('is case-insensitive for dismiss', () => {
    const result = parseDonmergeCommand('@donmerge Dismiss abc123');
    expect(result).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
  });

  it('handles extra whitespace', () => {
    const result = parseDonmergeCommand('  @donmerge   dismiss   abc123  ');
    expect(result).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
  });

  it('handles fingerprints with hyphens and underscores', () => {
    const result = parseDonmergeCommand('@donmerge accept my-fingerprint_123');
    expect(result).toEqual({ type: 'accept', fingerprint: 'my-fingerprint_123' });
  });

  it('returns null for non-donmerge commands', () => {
    expect(parseDonmergeCommand('please fix this')).toBeNull();
    expect(parseDonmergeCommand('@otherbot dismiss abc')).toBeNull();
  });

  it('returns null for incomplete commands', () => {
    expect(parseDonmergeCommand('@donmerge')).toBeNull();
    expect(parseDonmergeCommand('@donmerge dismiss')).toBeNull();
    expect(parseDonmergeCommand('@donmerge accept')).toBeNull();
  });

  it('returns null for override with invalid severity', () => {
    expect(parseDonmergeCommand('@donmerge override abc123 major')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDonmergeCommand('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseDonmergeCommand('   ')).toBeNull();
  });
});

// ─── handleCommentFeedback ──────────────────────────────────────────

describe('handleCommentFeedback', () => {
  it('stores dismiss feedback and creates learning', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge dismiss abc123',
      commentId: 100,
      inReplyToId: 50,
    });

    expect(result).toBe(true);
    // Should call recordFeedback (prepare → bind → run) and upsertLearning (prepare → bind → first → prepare → bind → run)
    expect(mock.prepare).toHaveBeenCalled();
  });

  it('stores accept feedback', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge accept def456',
      commentId: 101,
      inReplyToId: 51,
    });

    expect(result).toBe(true);
    expect(mock.prepare).toHaveBeenCalled();
  });

  it('stores override feedback with new severity', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge override abc123 suggestion',
      commentId: 102,
      inReplyToId: 52,
    });

    expect(result).toBe(true);
  });

  it('stores preference learning', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge preference No PHPDoc needed',
      commentId: 100,
    });

    expect(result).toBe(true);
    expect(mock.prepare).toHaveBeenCalled();
  });

  it('stores ignore as learning with ignore category', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge ignore PHPDoc comments',
      commentId: 100,
    });

    expect(result).toBe(true);
  });

  it('stores focus as learning with focus category', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge focus authentication',
      commentId: 100,
    });

    expect(result).toBe(true);
  });

  it('returns false for non-command comments', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: 'this looks wrong',
      commentId: 100,
    });

    expect(result).toBe(false);
    // No DB calls for non-commands
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it('returns false for dismiss without inReplyToId', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge dismiss abc123',
      commentId: 100,
      // no inReplyToId
    });

    // dismiss with fingerprint but no inReplyToId falls through to the preference check
    // which doesn't match, so returns false
    expect(result).toBe(false);
  });

  it('returns false for accept without inReplyToId', async () => {
    const mock = createMockDb();

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge accept def456',
      commentId: 100,
    });

    expect(result).toBe(false);
  });
});

// ─── handleReactionFeedback ─────────────────────────────────────────

describe('handleReactionFeedback', () => {
  it('returns false when no fingerprint provided', async () => {
    const mock = createMockDb();

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'thumbsdown',
      commentId: 100,
      // no commentFingerprint
    });

    expect(result).toBe(false);
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it('stores thumbsdown as dismiss feedback', async () => {
    const mock = createMockDb();

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'thumbsdown',
      commentId: 100,
      commentFingerprint: 'fp-abc',
    });

    expect(result).toBe(true);
    expect(mock.prepare).toHaveBeenCalled();
  });

  it('stores thumbsup as accept feedback', async () => {
    const mock = createMockDb();

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'thumbsup',
      commentId: 100,
      commentFingerprint: 'fp-abc',
    });

    expect(result).toBe(true);
  });

  it('returns false for unknown reaction types', async () => {
    const mock = createMockDb();

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'heart',
      commentId: 100,
      commentFingerprint: 'fp-abc',
    });

    expect(result).toBe(false);
  });

  it('returns false for hooray reaction', async () => {
    const mock = createMockDb();

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'hooray',
      commentId: 100,
      commentFingerprint: 'fp-abc',
    });

    expect(result).toBe(false);
  });

  it('creates learning from thumbsdown with outcome body', async () => {
    const mock = createMockDb({ firstResult: { body: 'SQL injection vulnerability in query' } });

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'thumbsdown',
      commentId: 100,
      commentFingerprint: 'fp-abc',
    });

    expect(result).toBe(true);
    // Should have called first() to look up the review_outcome body
    expect(mock.first).toHaveBeenCalled();
  });

  it('creates generic learning from thumbsdown when no outcome body', async () => {
    const mock = createMockDb({ firstResult: null });

    const result = await handleReactionFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      reaction: 'thumbsdown',
      commentId: 100,
      commentFingerprint: 'fp-abc',
    });

    expect(result).toBe(true);
  });
});
