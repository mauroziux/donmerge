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

  it.each([
    ['preference', 'Logging is useful\nexcept in tests', 'Logging is useful\nexcept in tests'],
    ['ignore', 'Logging\nexcept security events', "Don't comment on: Logging\nexcept security events"],
    ['focus', 'Authentication\nand authorization', 'Focus on: Authentication\nand authorization'],
  ])('preserves multiline %s directives', (command, body, expected) => {
    expect(parseDonmergeCommand(`@donmerge ${command} ${body}`)).toEqual({
      type: 'preference', text: expected,
    });
  });

  it('does not execute a later quoted command inside a multiline preference', () => {
    expect(parseDonmergeCommand('@donmerge preference Keep this rule\nExample: @donmerge dismiss'))
      .toEqual({ type: 'preference', text: 'Keep this rule\nExample: @donmerge dismiss' });
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

  it('parses command syntax; question intent is gated downstream by the classifier', () => {
    // parseDonmergeCommand is pure syntax. Whether '@donmerge dismiss?' is a
    // real directive or a question is decided by classifyCommandIntent in the
    // webhook layer (LLM → CLEF → punctuation), not here.
    expect(parseDonmergeCommand('@donmerge dismiss?')).toEqual({ type: 'dismiss' });
  });

  it('returns null for incomplete commands; bare dismiss/accept are valid (reply-correlated)', () => {
    expect(parseDonmergeCommand('@donmerge')).toBeNull();
    expect(parseDonmergeCommand('@donmerge dismiss')).toEqual({ type: 'dismiss', fingerprint: undefined });
    expect(parseDonmergeCommand('@donmerge accept')).toEqual({ type: 'accept', fingerprint: undefined });
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
    // Body lookup must not select a same-fingerprint finding from another PR.
    expect(mock.prepare).toHaveBeenCalledWith(expect.stringMatching(/pr_number = \? AND github_comment_id = \? AND fingerprint = \?/));
    expect(mock.bind).toHaveBeenCalledWith('test', 'repo', 1, 100, 'fp-abc');
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

// ─── handleNaturalReply (natural-language reply learning) ───────────

import { handleNaturalReply } from '../feedback-handler';

describe('handleNaturalReply', () => {
  it('learns dismiss from a "no aplica" reply and returns an ack (model verdict)', async () => {
    const mock = createMockDb();
    const { vi } = await import('vitest');
    const llmFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"type":"dismiss","reason":"No aplica porque el null ya se valida arriba","learning":null}' } }],
      }),
    });
    vi.stubGlobal('fetch', llmFetch);
    try {
      const ack = await handleNaturalReply(mock.db, { OPENAI_API_KEY: 'sk-x' }, {
        owner: 'test',
        repo: 'repo',
        prNumber: 1,
        githubUser: 'dev',
        replyText: 'No aplica porque el null ya se valida arriba',
        parentFingerprint: 'fp-abc',
        parentCommentId: 123,
        parentBody: '<!-- DONMERGE: {"fingerprint":"fp-abc","version":1} -->\n\nPossible null dereference here',
        filePath: 'src/index.ts',
      });

      expect(ack).not.toBeNull();
      expect(ack!.classification.type).toBe('dismiss');
      expect(ack!.ackBody).toContain('Learned');
      expect(ack!.ackBody).toContain('null ya se valida');
      expect(ack!.ackBody).not.toContain('@donmerge');
      // Feedback insert ran with source 'reply' and the parent fingerprint
      const feedbackCall = mock.bind.mock.calls.find((call: unknown[]) =>
        call.some((arg) => arg === 'reply' && call.includes('fp-abc'))
      );
      expect(feedbackCall).toBeDefined();
      expect(mock.bind).toHaveBeenCalledWith('dismissed', 'reply', 'test', 'repo', 1, 123, 'fp-abc');
      // Learning stored in the ignore category with the human's reason
      const learningCall = mock.bind.mock.calls.find((call: unknown[]) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('null ya se valida'))
      );
      expect(learningCall).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not classify a question as a dismissal or store a learning', async () => {
    const mock = createMockDb();
    const ack = await handleNaturalReply(mock.db, {}, {
      owner: 'test', repo: 'repo', prNumber: 1, githubUser: 'dev',
      replyText: 'Is this a false positive?',
      parentFingerprint: 'fp-q', parentBody: 'finding',
    });
    expect(ack).toBeNull();
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it('makes no writes and no ack when the model verdict is question', async () => {
    const mock = createMockDb();
    const { vi } = await import('vitest');
    const llmFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"type":"question","reason":"asking whether it applies","learning":null}' } }],
      }),
    });
    vi.stubGlobal('fetch', llmFetch);
    try {
      const ack = await handleNaturalReply(mock.db, { OPENAI_API_KEY: 'sk-x' }, {
        owner: 'test', repo: 'repo', prNumber: 1, githubUser: 'dev',
        replyText: 'Does this apply here?',
        parentFingerprint: 'fp-model-q', parentBody: 'finding',
      });
      expect(ack).toBeNull();
      expect(mock.prepare).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('makes no writes and no ack when the model verdict is other', async () => {
    const mock = createMockDb();
    const { vi } = await import('vitest');
    const llmFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"type":"other","reason":"chit chat","learning":null}' } }],
      }),
    });
    vi.stubGlobal('fetch', llmFetch);
    try {
      const ack = await handleNaturalReply(mock.db, { OPENAI_API_KEY: 'sk-x' }, {
        owner: 'test', repo: 'repo', prNumber: 1, githubUser: 'dev',
        replyText: 'hola, cómo vas?',
        parentFingerprint: 'fp-model-o', parentBody: 'finding',
      });
      expect(ack).toBeNull();
      expect(mock.prepare).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not write or acknowledge a punctuation-free Spanish command question', async () => {
    const mock = createMockDb();
    const ack = await handleNaturalReply(mock.db, {}, {
      owner: 'test', repo: 'repo', prNumber: 1, githubUser: 'dev',
      replyText: 'Hola @donmerge preference por  qué no aplica',
      parentFingerprint: 'fp-spanish-question', parentBody: 'finding',
    });
    expect(ack).toBeNull();
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it('learns accept from a "good catch" reply (model verdict)', async () => {
    const mock = createMockDb();
    const { vi } = await import('vitest');
    const llmFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"type":"accept","reason":"good catch, fixing now","learning":null}' } }],
      }),
    });
    vi.stubGlobal('fetch', llmFetch);
    try {
      const ack = await handleNaturalReply(mock.db, { OPENAI_API_KEY: 'sk-x' }, {
        owner: 'test',
        repo: 'repo',
        prNumber: 1,
        githubUser: 'dev',
        replyText: 'good catch, lo arreglé en 1a2b3c4',
        parentFingerprint: 'fp-def',
        parentBody: '<!-- DONMERGE: {"fingerprint":"fp-def","version":1} -->\n\nMissing error handling',
        filePath: 'src/api.ts',
      });

      expect(ack).not.toBeNull();
      expect(ack!.classification.type).toBe('accept');
      expect(ack!.ackBody).toContain('Confirmed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the LLM learning text when provided', async () => {
    const mock = createMockDb();
    const { vi } = await import('vitest');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"type":"dismiss","reason":"DI container guarantees it","learning":"Don\'t flag nullable ctor params in services"}' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const ack = await handleNaturalReply(mock.db, { OPENAI_API_KEY: 'sk-x' }, {
        owner: 'test',
        repo: 'repo',
        prNumber: 1,
        githubUser: 'dev',
        replyText: 'the container always passes a valid instance',
        parentFingerprint: 'fp-ghi',
        parentBody: 'nullable param may be undefined',
        filePath: 'src/service.ts',
      });

      expect(ack).not.toBeNull();
      const learningCall = mock.bind.mock.calls.find((call: unknown[]) =>
        call.some((arg) => typeof arg === 'string' && arg.includes("Don't flag nullable ctor params"))
      );
      expect(learningCall).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null (no ack, no writes) for a question reply', async () => {
    const mock = createMockDb();

    const ack = await handleNaturalReply(mock.db, {}, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      replyText: 'why do you consider this unsafe here?',
      parentFingerprint: 'fp-x',
      parentBody: 'unsafe deserialization',
    });

    expect(ack).toBeNull();
    expect(mock.prepare).not.toHaveBeenCalled();
  });

  it('returns null when the reply is empty', async () => {
    const mock = createMockDb();
    const ack = await handleNaturalReply(mock.db, {}, {
      owner: 'test', repo: 'repo', prNumber: 1, githubUser: 'dev',
      replyText: '   ',
      parentFingerprint: 'fp-x',
      parentBody: 'finding',
    });
    expect(ack).toBeNull();
  });
});

// ─── Command dismiss learning uses the finding body ─────────────────

describe('handleCommentFeedback — dismiss learning text', () => {
  it('stores a learning that quotes the actual finding body', async () => {
    const mock = createMockDb({ firstResult: { body: 'Unhandled promise rejection in loop', file_path: 'src/jobs.ts' } });

    const result = await handleCommentFeedback(mock.db, {
      owner: 'test',
      repo: 'repo',
      prNumber: 1,
      githubUser: 'dev',
      commentBody: '@donmerge dismiss fp-abc',
      commentId: 10,
      inReplyToId: 5,
    });

    expect(result).toBe(true);
    const learningCall = mock.bind.mock.calls.find((call: unknown[]) =>
      call.some((arg) => typeof arg === 'string' && arg.includes("Don't flag findings like"))
    );
    expect(learningCall).toBeDefined();
    const args = (learningCall as unknown[]).flat();
    expect(args.some((a) => typeof a === 'string' && a.includes('Unhandled promise rejection'))).toBe(true);
  });
});
