/**
 * Tests for processor-utils.ts
 *
 * These tests cover the pure logic extracted from ReviewProcessor:
 * - validateReviewResult: LLM output validation
 * - normalizeReviewResult: result normalization and issue key reconciliation
 * - filterCommentsByMatch: deduplication of comments
 * - calculateIssueOverlapScore: text similarity scoring
 * - hasStrongIssueTextOverlap: threshold-based overlap detection
 * - reconcileIssueKeys: stable key assignment across re-runs
 * - syncTrackedIssuesFromComments: comment-ID attachment to stored issues
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateReviewResult,
  normalizeReviewResult,
  normalizeCommentBody,
  filterLineCommentsByQuality,
  filterCriticalIssuesByQuality,
  hasBlockingFindings,
  withBlockingApproval,
  filterCommentsByMatch,
  calculateIssueOverlapScore,
  hasStrongIssueTextOverlap,
  reconcileIssueKeys,
  syncTrackedIssuesFromComments,
} from '../processor-utils';
import { createReviewComment, createPreviousComment, createTrackedIssue, resetIssueCounter } from './helpers';
import type { ReviewResult, TrackedIssue } from '../types';

beforeEach(() => {
  resetIssueCounter();
});

// ─── validateReviewResult ───────────────────────────────────────────

describe('validateReviewResult', () => {
  function makeValidResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return {
      approved: true,
      summary: 'Code looks good',
      prSummary: {
        overview: 'Adds user authentication',
        keyChanges: ['Added login endpoint', 'Added JWT middleware'],
        codeQuality: 'Clean and well-structured',
        testingNotes: 'Tests cover main flows',
        riskAssessment: 'Low risk',
      },
      lineComments: [],
      criticalIssues: [],
      suggestions: [],
      resolvedComments: [],
      ...overrides,
    };
  }

  it('should validate a correct result', () => {
    const result = makeValidResult();
    expect(validateReviewResult(result)).toEqual({ valid: true });
  });

  it('should reject null/undefined', () => {
    expect(validateReviewResult(null as any)).toEqual({ valid: false, reason: 'result is not an object' });
    expect(validateReviewResult(undefined as any)).toEqual({ valid: false, reason: 'result is not an object' });
  });

  it('should reject missing summary', () => {
    const result = makeValidResult({ summary: '' });
    expect(validateReviewResult(result).valid).toBe(false);
    expect(validateReviewResult(result).reason).toContain('missing summary');
  });

  it('should reject missing prSummary', () => {
    const result = makeValidResult({ prSummary: undefined });
    expect(validateReviewResult(result).valid).toBe(false);
    expect(validateReviewResult(result).reason).toContain('missing prSummary');
  });

  it('should reject missing prSummary.overview', () => {
    const result = makeValidResult({
      prSummary: {
        overview: '',
        keyChanges: ['change'],
        codeQuality: 'good',
        testingNotes: 'covered',
        riskAssessment: 'low',
      },
    });
    expect(validateReviewResult(result).reason).toContain('missing prSummary.overview');
  });

  it('should reject empty keyChanges', () => {
    const result = makeValidResult({
      prSummary: {
        overview: 'desc',
        keyChanges: [],
        codeQuality: 'good',
        testingNotes: 'covered',
        riskAssessment: 'low',
      },
    });
    expect(validateReviewResult(result).reason).toContain('missing prSummary.keyChanges');
  });

  it('should reject missing codeQuality', () => {
    const result = makeValidResult({
      prSummary: {
        overview: 'desc',
        keyChanges: ['change'],
        codeQuality: '',
        testingNotes: 'covered',
        riskAssessment: 'low',
      },
    });
    expect(validateReviewResult(result).reason).toContain('missing prSummary.codeQuality');
  });

  it('should reject missing testingNotes', () => {
    const result = makeValidResult({
      prSummary: {
        overview: 'desc',
        keyChanges: ['change'],
        codeQuality: 'good',
        testingNotes: '',
        riskAssessment: 'low',
      },
    });
    expect(validateReviewResult(result).reason).toContain('missing prSummary.testingNotes');
  });

  it('should reject missing riskAssessment', () => {
    const result = makeValidResult({
      prSummary: {
        overview: 'desc',
        keyChanges: ['change'],
        codeQuality: 'good',
        testingNotes: 'covered',
        riskAssessment: '',
      },
    });
    expect(validateReviewResult(result).reason).toContain('missing prSummary.riskAssessment');
  });

  it('should reject lineComment without issueKey', () => {
    const result = makeValidResult({
      lineComments: [
        createReviewComment({
          path: 'src/index.ts',
          line: 10,
          side: 'RIGHT',
          body: 'Some comment without issue section',  // No **Issue:** pattern and no issueKey
          severity: 'critical',
          issueKey: undefined,
        }),
      ],
    });
    const validation = validateReviewResult(result);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('missing issueKey');
  });

  it('should accept lineComment with issueKey', () => {
    const result = makeValidResult({
      lineComments: [
        createReviewComment({
          path: 'src/index.ts',
          line: 10,
          side: 'RIGHT',
          body: '🔴 **Issue:** SQL injection\n\n💡 **Suggestion:** Use parameterized queries',
          severity: 'critical',
          issueKey: 'sql-injection-vulnerability',
        }),
      ],
    });
    expect(validateReviewResult(result).valid).toBe(true);
  });

  it('should accept criticalIssues with empty lineComments', () => {
    const result = makeValidResult({
      criticalIssues: ['SQL injection'],
      lineComments: [],
      approved: false,
    });
    expect(validateReviewResult(result).valid).toBe(true);
  });

  it('should accept criticalIssues with matching lineComments', () => {
    const result = makeValidResult({
      criticalIssues: ['SQL injection'],
      lineComments: [
        createReviewComment({
          body: '🔴 **Issue:** SQL injection\n\n💡 **Suggestion:** Fix it',
          issueKey: 'sql-injection',
          severity: 'critical',
        }),
      ],
      approved: false,
    });
    expect(validateReviewResult(result).valid).toBe(true);
  });
});

// ─── normalizeReviewResult ──────────────────────────────────────────

describe('normalizeReviewResult', () => {
  it('should normalize approved=true when no issues', () => {
    const result: ReviewResult = {
      approved: false, // LLM might say false, but normalization corrects
      summary: 'Good code',
      prSummary: {
        overview: 'Minor refactor',
        keyChanges: ['Cleaned up imports'],
        codeQuality: 'Clean',
        testingNotes: 'Existing tests pass',
        riskAssessment: 'Low',
      },
      lineComments: [],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.approved).toBe(true);
  });

  it('should normalize approved=false when critical lineComments exist', () => {
    const result: ReviewResult = {
      approved: true,
      summary: 'Has issues',
      prSummary: {
        overview: 'Adds feature',
        keyChanges: ['New endpoint'],
        codeQuality: 'Needs work',
        testingNotes: 'Missing tests',
        riskAssessment: 'Medium',
      },
      lineComments: [
        createReviewComment({
          body: '🔴 **Issue:** Missing null check throws when user is undefined\n\n💡 **Suggestion:** Add checks',
          issueKey: 'missing-null-check',
          severity: 'critical',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.approved).toBe(false);
  });

  it('should normalize approved=false when validated criticalIssues exist', () => {
    const result: ReviewResult = {
      approved: true,
      summary: 'Has critical',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Bad',
        testingNotes: 'None',
        riskAssessment: 'High',
      },
      lineComments: [
        createReviewComment({
          body: '🔴 **Issue:** Missing null check throws when user is undefined\n\n💡 **Suggestion:** Add a guard',
          issueKey: 'missing-null-check',
          severity: 'critical',
        }),
      ],
      criticalIssues: ['Missing null check throws when user is undefined'],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.approved).toBe(false);
  });

  it('should derive issueKey for lineComments', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          body: '🔴 **Issue:** The SQL query allows injection because user input is concatenated into the WHERE clause',
          issueKey: undefined,
          severity: 'critical',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.lineComments[0].issueKey).toBeDefined();
  });

  it('should reconcile issueKeys with previous comments', () => {
    const previousComment = createPreviousComment({
      id: 1,
      path: 'src/auth.ts',
      line: 10,
      body: '🔴 **Issue:** SQL injection in auth allows attackers to bypass login\n\n💡 **Suggestion:** Use prepared statements',
      issueKey: 'sql-injection-auth',
    });

    const result: ReviewResult = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/auth.ts',
          line: 10,
          body: '🔴 **Issue:** SQL injection in auth module allows attackers to bypass login\n\n💡 **Suggestion:** Use prepared statements',
          issueKey: 'sql-injection',
          severity: 'critical',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result, [previousComment]);
    // Should reconcile to the previous issueKey
    expect(normalized.lineComments[0].issueKey).toBe('sql-injection-auth');
  });

  it('should handle missing prSummary gracefully', () => {
    const result: ReviewResult = {
      approved: true,
      summary: 'Good',
      lineComments: [],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.prSummary).toBeUndefined();
    expect(normalized.summary).toBe('Good');
  });

  it('should normalize double-escaped newlines in comment body', () => {
    const result = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          body: '🟡 **Suggestion:** This branch returns stale cache when input is empty, causing an incorrect result.\n\n🤖 **AI Prompt:**\n```\\nVerify code.\\n```',
          issueKey: 'stale-cache-empty-input',
          severity: 'suggestion',
          codeSnippet: 'if (!input) return cache;',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.lineComments[0].body).toContain('```\nVerify code.\n```');
  });

  it('should default arrays when missing', () => {
    const result = {
      summary: 'Good',
      prSummary: {
        overview: 'desc',
        keyChanges: ['change'],
        codeQuality: 'ok',
        testingNotes: 'ok',
        riskAssessment: 'low',
      },
      approved: true,
    } as ReviewResult;

    const normalized = normalizeReviewResult(result);
    expect(normalized.lineComments).toEqual([]);
    expect(normalized.criticalIssues).toEqual([]);
    expect(normalized.suggestions).toEqual([]);
    expect(normalized.resolvedComments).toEqual([]);
    expect(normalized.fileSummaries).toEqual([]);
  });
});

// ─── line comment quality gate / blocking semantics ──────────────────

describe('filterLineCommentsByQuality', () => {
  it('drops style-only comments such as import ordering', () => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: '🔴 **Issue:** Imports should be alphabetical.\n\n💡 **Suggestion:** Sort imports.',
        issueKey: 'sort-imports',
        severity: 'critical',
      }),
    ]);

    expect(comments).toEqual([]);
  });

  it('drops vague advisory comments without a concrete failure mechanism', () => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: '🔴 **Issue:** Consider adding tests to verify this behavior.\n\n💡 **Suggestion:** Add tests.',
        issueKey: 'add-tests',
        severity: 'suggestion',
      }),
    ]);

    expect(comments).toEqual([]);
  });

  it('drops vague critical advisory comments even when they include a code snippet', () => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: '🔴 **Issue:** Consider adding tests for this branch.\n\n💡 **Suggestion:** Add tests.',
        issueKey: 'add-tests-for-branch',
        severity: 'critical',
        codeSnippet: 'if (featureFlag) return newBehavior();',
      }),
    ]);

    expect(comments).toEqual([]);
  });

  it('drops vague critical domain comments without a concrete failure mechanism', () => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: '🔴 **Issue:** Ensure authentication is handled here.\n\n💡 **Suggestion:** Check the auth flow.',
        issueKey: 'ensure-authentication',
        severity: 'critical',
      }),
      createReviewComment({
        body: '🔴 **Issue:** Verify token handling.\n\n💡 **Suggestion:** Confirm token behavior.',
        issueKey: 'verify-token-handling',
        severity: 'critical',
      }),
    ]);

    expect(comments).toEqual([]);
  });

  it('keeps concrete critical security/runtime findings', () => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: '🔴 **Issue:** The token is logged when authentication fails, exposing credentials in production logs.\n\n💡 **Suggestion:** Remove the token from the log payload.',
        issueKey: 'token-logged-on-auth-failure',
        severity: 'critical',
      }),
    ]);

    expect(comments).toHaveLength(1);
    expect(comments[0].severity).toBe('critical');
  });

  it.each([
    'User input is concatenated into SQL, enabling SQL injection.',
    'SQL query is vulnerable to injection attacks - user input is directly concatenated.',
  ])('keeps concrete SQL injection findings with vulnerability mechanisms: %s', (body) => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: `🔴 **Issue:** ${body}\n\n💡 **Suggestion:** Use parameterized queries.`,
        issueKey: 'sql-injection-concatenated-input',
        severity: 'critical',
      }),
    ]);

    expect(comments).toHaveLength(1);
    expect(comments[0].severity).toBe('critical');
    expect(hasBlockingFindings({ lineComments: comments, criticalIssues: [] })).toBe(true);
  });

  it.each([
    'This dereferences user.id when user is null, causing a runtime exception.',
    'The unsynchronized balance update allows a race condition that loses payments.',
    'Deleting the parent row causes data loss because child records are not migrated.',
    'The missing ownership check allows a security bypass that exposes another user\'s data.',
  ])('keeps concrete critical findings with consequences: %s', (body) => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: `🔴 **Issue:** ${body}\n\n💡 **Suggestion:** Fix the failing path.`,
        issueKey: 'concrete-critical-finding',
        severity: 'critical',
      }),
    ]);

    expect(comments).toHaveLength(1);
    expect(comments[0].severity).toBe('critical');
  });

  it('labels kept non-critical comments as non-blocking suggestions', () => {
    const comments = filterLineCommentsByQuality([
      createReviewComment({
        body: '🔴 **Issue:** This branch returns stale cache when input is empty, causing an incorrect result.\n\n💡 **Suggestion:** Return a fresh value for empty input.',
        issueKey: 'stale-cache-empty-input',
        severity: 'suggestion',
        codeSnippet: 'if (!input) return cache;',
      }),
    ]);

    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('🟡 **Suggestion:**');
    expect(hasBlockingFindings({ lineComments: comments, criticalIssues: [] })).toBe(false);
  });
});

describe('filterCriticalIssuesByQuality', () => {
  it('drops vague criticalIssues so they do not block approval', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Needs tests',
      prSummary: {
        overview: 'Adds a branch',
        keyChanges: ['Added feature flag branch'],
        codeQuality: 'Ok',
        testingNotes: 'Could use more tests',
        riskAssessment: 'Low',
      },
      lineComments: [],
      criticalIssues: ['Add more tests'],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.criticalIssues).toEqual([]);
    expect(normalized.approved).toBe(true);
    expect(hasBlockingFindings({ lineComments: [], criticalIssues: ['Add more tests'] })).toBe(false);
  });

  it('drops vague criticalIssues that only mention critical domains', () => {
    const issues = filterCriticalIssuesByQuality([
      'Ensure authentication is handled here',
      'Verify token handling',
    ]);

    expect(issues).toEqual([]);
    expect(hasBlockingFindings({ lineComments: [], criticalIssues: ['Verify token handling'] })).toBe(false);
  });

  it('drops style-only criticalIssues', () => {
    expect(filterCriticalIssuesByQuality(['Sort imports alphabetically'])).toEqual([]);
  });

  it('keeps validated summary-level critical findings', () => {
    const issues = filterCriticalIssuesByQuality([
      'Authentication bypass allows users without permission to access admin data',
    ]);

    expect(issues).toEqual([
      'Authentication bypass allows users without permission to access admin data',
    ]);
    expect(hasBlockingFindings({ lineComments: [], criticalIssues: issues })).toBe(true);
  });

  it.each([
    'User input is concatenated into SQL, enabling SQL injection.',
    'SQL query is vulnerable to injection attacks - user input is directly concatenated.',
  ])('keeps summary-level SQL injection findings with vulnerability mechanisms: %s', (issue) => {
    expect(filterCriticalIssuesByQuality([issue])).toEqual([issue]);
    expect(hasBlockingFindings({ lineComments: [], criticalIssues: [issue] })).toBe(true);
  });

  it.each([
    'Null dereference throws when user is missing',
    'Race condition allows two workers to overwrite each other and lose queued jobs',
    'Deleting the account before export causes data loss',
    'Security bypass allows unauthenticated users to access admin data',
  ])('keeps concrete criticalIssues with consequences: %s', (issue) => {
    expect(filterCriticalIssuesByQuality([issue])).toEqual([issue]);
  });
});

// ─── filterCommentsByMatch ──────────────────────────────────────────

describe('filterCommentsByMatch', () => {
  it('should return all comments when no current issues', () => {
    const comments = [
      createReviewComment({ path: 'a.ts', issueKey: 'issue-a', severity: 'critical' }),
      createReviewComment({ path: 'b.ts', issueKey: 'issue-b', severity: 'suggestion' }),
    ];

    const result = filterCommentsByMatch(comments, [], [], [], []);
    expect(result).toHaveLength(2);
  });

  it('should only include new issues', () => {
    const comments = [
      createReviewComment({ path: 'a.ts', issueKey: 'new-issue', severity: 'critical' }),
      createReviewComment({ path: 'b.ts', issueKey: 'persisting-issue', severity: 'suggestion' }),
    ];

    const result = filterCommentsByMatch(
      comments,
      ['fp-new', 'fp-persisting'],
      ['new-issue|function|fn', 'persisting-issue|function|fn'],
      ['fp-new'],  // only the first is new
      []
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('a.ts');
  });

  it('should include reintroduced issues', () => {
    const comments = [
      createReviewComment({ path: 'a.ts', issueKey: 'reintroduced-issue', severity: 'critical' }),
      createReviewComment({ path: 'b.ts', issueKey: 'persisting-issue', severity: 'suggestion' }),
    ];

    const result = filterCommentsByMatch(
      comments,
      ['fp-reintroduced', 'fp-persisting'],
      ['reintroduced-issue|function|fn', 'persisting-issue|function|fn'],
      [],
      ['reintroduced-issue|function|fn']  // reintroduced
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('a.ts');
  });

  it('should exclude persisting issues', () => {
    const comments = [
      createReviewComment({ path: 'a.ts', issueKey: 'persisting', severity: 'critical' }),
    ];

    const result = filterCommentsByMatch(
      comments,
      ['fp-persisting'],
      ['persisting|function|fn'],
      [],       // no new
      []        // no reintroduced
    );

    expect(result).toHaveLength(0);
  });

  it('should allow approval after all critical line comments are filtered as persisting duplicates', () => {
    const comments = [
      createReviewComment({
        path: 'a.ts',
        issueKey: 'persisting-null-deref',
        severity: 'critical',
        body: '🔴 **Issue:** This dereferences user.id when user is null, causing a runtime exception.',
      }),
    ];

    const filteredComments = filterCommentsByMatch(
      comments,
      ['fp-persisting'],
      ['persisting-null-deref|function|fn'],
      [],
      []
    );
    const result = withBlockingApproval({
      approved: false,
      summary: 'Issues found',
      lineComments: filteredComments,
      criticalIssues: [],
      suggestions: [],
    });

    expect(filteredComments).toEqual([]);
    expect(result.approved).toBe(true);
    expect(hasBlockingFindings(result)).toBe(false);
  });

  it('should keep failure after deduplication when validated criticalIssues remain', () => {
    const result = withBlockingApproval({
      approved: false,
      summary: 'Issues found',
      lineComments: [],
      criticalIssues: ['Security bypass allows unauthenticated users to access admin data'],
      suggestions: [],
    });

    expect(result.approved).toBe(false);
    expect(hasBlockingFindings(result)).toBe(true);
  });
});

// ─── calculateIssueOverlapScore ─────────────────────────────────────

describe('calculateIssueOverlapScore', () => {
  it('should return 0 for empty arrays', () => {
    expect(calculateIssueOverlapScore([], ['a', 'b'])).toBe(0);
    expect(calculateIssueOverlapScore(['a', 'b'], [])).toBe(0);
  });

  it('should return 1 for identical sets', () => {
    expect(calculateIssueOverlapScore(['sql', 'injection', 'query'], ['sql', 'injection', 'query'])).toBe(1);
  });

  it('should return 0 for disjoint sets', () => {
    expect(calculateIssueOverlapScore(['sql', 'injection'], ['css', 'styling'])).toBe(0);
  });

  it('should calculate partial overlap', () => {
    // overlap: {sql, injection, query} = 3 out of min(4, 3) = 3 → 3/3 = 1.0
    const score1 = calculateIssueOverlapScore(
      ['sql', 'injection', 'query', 'database'],
      ['sql', 'injection', 'query']
    );
    expect(score1).toBe(1);

    // overlap: {sql, injection} = 2 out of min(4, 3) = 3 → 2/3 ≈ 0.667
    const score2 = calculateIssueOverlapScore(
      ['sql', 'injection', 'query', 'database'],
      ['sql', 'injection', 'other']
    );
    expect(score2).toBeCloseTo(0.667, 2);
  });

  it('should handle duplicate terms (deduplicates via Set)', () => {
    expect(calculateIssueOverlapScore(['sql', 'sql'], ['sql', 'sql'])).toBe(1);
  });
});

// ─── hasStrongIssueTextOverlap ──────────────────────────────────────

describe('hasStrongIssueTextOverlap', () => {
  it('should return false for empty arrays', () => {
    expect(hasStrongIssueTextOverlap([], ['sql'])).toBe(false);
    expect(hasStrongIssueTextOverlap(['sql'], [])).toBe(false);
  });

  it('should require at least 2 overlapping terms', () => {
    expect(hasStrongIssueTextOverlap(['sql', 'injection'], ['sql'])).toBe(false);
  });

  it('should require 50% overlap ratio', () => {
    // 2 overlap out of min(4, 5) = 4 → 2/4 = 0.5 ≥ 0.5 → true
    expect(
      hasStrongIssueTextOverlap(
        ['sql', 'injection', 'query', 'database'],
        ['sql', 'injection', 'query', 'user', 'auth']
      )
    ).toBe(true);

    // 2 overlap out of min(4, 6) = 4 → 2/4 = 0.5 ≥ 0.5 → true
    expect(
      hasStrongIssueTextOverlap(
        ['sql', 'injection', 'query', 'database'],
        ['sql', 'injection', 'query', 'user', 'auth', 'token']
      )
    ).toBe(true);

    // 1 overlap out of min(3, 4) = 3 → 1/3 ≈ 0.33 < 0.5 → false
    expect(
      hasStrongIssueTextOverlap(
        ['sql', 'injection', 'query'],
        ['sql', 'user', 'auth', 'token']
      )
    ).toBe(false);
  });

  it('should return true for highly overlapping terms', () => {
    expect(
      hasStrongIssueTextOverlap(
        ['sql', 'injection', 'vulnerability', 'query'],
        ['sql', 'injection', 'vulnerability', 'query', 'database']
      )
    ).toBe(true);
  });
});

// ─── reconcileIssueKeys ─────────────────────────────────────────────

describe('reconcileIssueKeys', () => {
  it('should return lineComments unchanged when no previous comments', () => {
    const comments = [
      createReviewComment({ issueKey: 'my-issue', severity: 'critical' }),
    ];

    const result = reconcileIssueKeys(comments, []);
    expect(result[0].issueKey).toBe('my-issue');
  });

  it('should return lineComments unchanged when empty', () => {
    const result = reconcileIssueKeys([], [createPreviousComment()]);
    expect(result).toEqual([]);
  });

  it('should reuse previous issueKey for matching comment on same file', () => {
    const previous = createPreviousComment({
      id: 1,
      path: 'src/auth.ts',
      line: 10,
      body: '🔴 **Issue:** SQL injection in auth\n\n💡 **Suggestion:** Use prepared statements',
      issueKey: 'sql-injection-auth',
    });

    const current = createReviewComment({
      path: 'src/auth.ts',
      line: 10,
      body: '🔴 **Issue:** SQL injection in auth module\n\n💡 **Suggestion:** Use prepared statements',
      issueKey: 'sql-injection',
      severity: 'critical',
    });

    const result = reconcileIssueKeys([current], [previous]);
    // Should reuse the stable previous issueKey
    expect(result[0].issueKey).toBe('sql-injection-auth');
  });

  it('should not change issueKey when no match found', () => {
    const previous = createPreviousComment({
      path: 'src/api.ts',
      body: '🔴 **Issue:** Different issue\n\n💡 **Suggestion:** Different fix',
      issueKey: 'different-issue',
    });

    const current = createReviewComment({
      path: 'src/auth.ts',
      body: '🔴 **Issue:** SQL injection\n\n💡 **Suggestion:** Fix it',
      issueKey: 'sql-injection',
      severity: 'critical',
    });

    const result = reconcileIssueKeys([current], [previous]);
    expect(result[0].issueKey).toBe('sql-injection');
  });

  it('should skip resolved previous comments', () => {
    const previous = createPreviousComment({
      id: 1,
      path: 'src/auth.ts',
      line: 10,
      body: '🔴 **Issue:** SQL injection\n\n💡 **Suggestion:** Fix',
      issueKey: 'sql-injection-auth',
      resolved: true,
    });

    const current = createReviewComment({
      path: 'src/auth.ts',
      line: 10,
      body: '🔴 **Issue:** SQL injection\n\n💡 **Suggestion:** Fix',
      issueKey: 'sql-injection',
      severity: 'critical',
    });

    const result = reconcileIssueKeys([current], [previous]);
    expect(result[0].issueKey).toBe('sql-injection');
  });
});

// ─── syncTrackedIssuesFromComments ──────────────────────────────────

describe('syncTrackedIssuesFromComments', () => {
  it('should return stored issues unchanged when no previous comments', () => {
    const issues = [createTrackedIssue()];
    const result = syncTrackedIssuesFromComments(issues, []);
    expect(result[0].githubCommentId).toBeUndefined();
  });

  it('should return stored issues unchanged when empty', () => {
    expect(syncTrackedIssuesFromComments([], [createPreviousComment()])).toEqual([]);
  });

  it('should attach githubCommentId when issue matches previous comment by ruleId+symbolName', () => {
    const issue = createTrackedIssue({
      filePath: 'src/auth.ts',
      ruleId: 'sql-injection',
      symbolName: 'loginUser',
      githubCommentId: undefined,
    });

    const previous = createPreviousComment({
      id: 42,
      path: 'src/auth.ts',
      body: 'Some comment',
      ruleId: 'sql-injection',
      symbolName: 'loginUser',
    });

    const result = syncTrackedIssuesFromComments([issue], [previous]);
    expect(result[0].githubCommentId).toBe(42);
  });

  it('should not overwrite existing githubCommentId', () => {
    const issue = createTrackedIssue({
      filePath: 'src/auth.ts',
      ruleId: 'sql-injection',
      githubCommentId: 100,
    });

    const previous = createPreviousComment({
      id: 42,
      path: 'src/auth.ts',
      ruleId: 'sql-injection',
    });

    const result = syncTrackedIssuesFromComments([issue], [previous]);
    expect(result[0].githubCommentId).toBe(100);
  });

  it('should match by issueKey prefix on logicalKey', () => {
    const issue = createTrackedIssue({
      filePath: 'src/auth.ts',
      ruleId: 'sql-injection',
      logicalKey: 'sql-injection|function|loginUser',
      githubCommentId: undefined,
    });

    const previous = createPreviousComment({
      id: 42,
      path: 'src/auth.ts',
      body: 'Some comment',
      issueKey: 'sql-injection',
    });

    const result = syncTrackedIssuesFromComments([issue], [previous]);
    expect(result[0].githubCommentId).toBe(42);
  });

  it('should match by strong text overlap as fallback', () => {
    const issue = createTrackedIssue({
      filePath: 'src/auth.ts',
      body: '🔴 **Issue:** SQL injection vulnerability in query builder',
      githubCommentId: undefined,
    });

    const previous = createPreviousComment({
      id: 42,
      path: 'src/auth.ts',
      body: '🔴 **Issue:** SQL injection vulnerability detected in query builder module',
    });

    const result = syncTrackedIssuesFromComments([issue], [previous]);
    // Should match via text overlap (sql, injection, vulnerability, query, builder all overlap)
    expect(result[0].githubCommentId).toBe(42);
  });

  it('should not match issues from different files', () => {
    const issue = createTrackedIssue({
      filePath: 'src/auth.ts',
      ruleId: 'sql-injection',
      githubCommentId: undefined,
    });

    const previous = createPreviousComment({
      id: 42,
      path: 'src/api.ts',  // different file
      ruleId: 'sql-injection',
    });

    const result = syncTrackedIssuesFromComments([issue], [previous]);
    expect(result[0].githubCommentId).toBeUndefined();
  });

  it('should not match when no criteria align', () => {
    const issue = createTrackedIssue({
      filePath: 'src/auth.ts',
      body: '🔴 **Issue:** CSS styling issue',
      githubCommentId: undefined,
    });

    const previous = createPreviousComment({
      id: 42,
      path: 'src/auth.ts',
      body: '🔴 **Issue:** SQL injection problem',
    });

    const result = syncTrackedIssuesFromComments([issue], [previous]);
    expect(result[0].githubCommentId).toBeUndefined();
  });
});

// ─── normalizeCommentBody ────────────────────────────────────────────

describe('normalizeCommentBody', () => {
  it('should replace literal \\n sequences with real newlines', () => {
    const input = '🤖 **AI Prompt:**\n```\\nVerify the code.\\n```';
    const result = normalizeCommentBody(input);
    expect(result).toBe('🤖 **AI Prompt:**\n```\nVerify the code.\n```');
    expect(result).not.toContain('\\n');
  });

  it('should leave bodies with real newlines unchanged', () => {
    const input = '🔴 **Issue:** Bug\n\n💡 **Suggestion:** Fix';
    expect(normalizeCommentBody(input)).toBe(input);
  });

  it('should handle empty string', () => {
    expect(normalizeCommentBody('')).toBe('');
  });

  it('should handle body with only literal \\n', () => {
    expect(normalizeCommentBody('\\n')).toBe('\n');
  });

  it('should handle multiple consecutive literal \\n', () => {
    expect(normalizeCommentBody('line1\\n\\nline2')).toBe('line1\n\nline2');
  });

  it('should handle mixed real newlines and literal \\n', () => {
    const input = 'line1\n\\n\\nline2';
    expect(normalizeCommentBody(input)).toBe('line1\n\n\nline2');
  });
});

// ─── normalizeReviewResult with severity overrides ──────────────────

describe('normalizeReviewResult — severity overrides', () => {
  it('should apply severity overrides to matching paths', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Issues found',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/auth/login.ts',
          body: '🔴 **Issue:** Weak password hashing allows credential compromise when hashes leak.\n\n💡 **Suggestion:** Use bcrypt',
          issueKey: 'weak-password',
          severity: 'suggestion',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const severityOverrides = { 'src/auth/**': 'critical' as const };
    const normalized = normalizeReviewResult(result, [], severityOverrides);
    expect(normalized.lineComments[0].severity).toBe('critical');
  });

  it('should not change severity for non-matching paths', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/utils/helper.ts',
          body: '🟡 **Suggestion:** This helper returns stale cache when input is empty, causing an incorrect result.\n\n💡 **Suggestion:** Return a fresh value.',
          issueKey: 'stale-cache-empty-input',
          severity: 'suggestion',
          codeSnippet: 'if (!input) return cache;',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const severityOverrides = { 'src/auth/**': 'critical' as const };
    const normalized = normalizeReviewResult(result, [], severityOverrides);
    expect(normalized.lineComments[0].severity).toBe('suggestion');
  });

  it('should not modify result when severity overrides is undefined', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/auth/login.ts',
          body: '🟡 **Suggestion:** This branch returns stale cache when input is empty, causing an incorrect result.\n\n💡 **Suggestion:** Return a fresh value.',
          issueKey: 'bug',
          severity: 'suggestion',
          codeSnippet: 'if (!input) return cache;',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result, []);
    expect(normalized.lineComments[0].severity).toBe('suggestion');
  });

  it('should not modify result when severity overrides is empty', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/auth.ts',
          body: '🔴 **Issue:** This dereferences user.id when user is null, causing a runtime exception.\n\n💡 **Suggestion:** Guard user before access.',
          issueKey: 'bug',
          severity: 'critical',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result, [], {});
    expect(normalized.lineComments[0].severity).toBe('critical');
  });

  it('should apply different overrides to different paths', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/auth/login.ts',
          body: '🔴 **Issue:** This dereferences session.user when session is null, causing a runtime exception.\n\n💡 **Suggestion:** Guard session before access.',
          issueKey: 'bug-a',
          severity: 'suggestion',
        }),
        createReviewComment({
          path: 'src/legacy/utils.ts',
          body: '🔴 **Issue:** This dereferences config.value when config is null, causing a runtime exception.\n\n💡 **Suggestion:** Guard config before access.',
          issueKey: 'bug-b',
          severity: 'critical',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const severityOverrides = {
      'src/auth/**': 'critical' as const,
      'src/legacy/**': 'low' as const,
    };
    const normalized = normalizeReviewResult(result, [], severityOverrides);
    expect(normalized.lineComments[0].severity).toBe('critical');
    expect(normalized.lineComments[1].severity).toBe('low');
  });

  it('should allow approval when only low-severity issues exist', () => {
    const result: ReviewResult = {
      approved: false,
      summary: 'Minor issues',
      prSummary: {
        overview: 'Desc',
        keyChanges: ['Change'],
        codeQuality: 'Ok',
        testingNotes: 'Ok',
        riskAssessment: 'Low',
      },
      lineComments: [
        createReviewComment({
          path: 'src/style.css',
          body: '🟡 **Suggestion:** This selector matches disabled buttons too, causing the wrong style in the disabled state.\n\n💡 **Suggestion:** Scope it to enabled buttons.',
          issueKey: 'disabled-button-selector',
          severity: 'low',
          codeSnippet: '.button:hover { color: red; }',
        }),
      ],
      criticalIssues: [],
      suggestions: [],
    };

    const normalized = normalizeReviewResult(result);
    expect(normalized.lineComments[0].severity).toBe('low');
    expect(normalized.approved).toBe(true);
  });
});
