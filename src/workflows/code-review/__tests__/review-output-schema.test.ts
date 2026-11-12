/**
 * Tests for the strict review-output contract (plan 002-U3).
 *
 * Core invariant: a structurally incomplete model output is INVALID. It must
 * go to format repair or fail the model — it can never be normalized into an
 * empty, approved review just because its summary reads well.
 */

import { describe, it, expect } from 'vitest';

import { parseReviewOutput } from '../review-output-schema';

function validOutput(): Record<string, unknown> {
  return {
    approved: true,
    summary: 'Coherent change, no blocking findings.',
    prSummary: {
      overview: 'Adds an idempotency key to the booking webhook.',
      keyChanges: ['Webhook stores idempotency key before creating the booking'],
      codeQuality: 'Clean.',
      testingNotes: 'Two new tests cover the retry path.',
      riskAssessment: 'Low.',
    },
    lineComments: [],
    criticalIssues: [],
    suggestions: [],
  };
}

describe('parseReviewOutput — required structure', () => {
  it('accepts a complete output', () => {
    const parsed = parseReviewOutput(validOutput());
    expect(parsed.ok).toBe(true);
  });

  it('rejects null/undefined/array outputs', () => {
    expect(parseReviewOutput(null).ok).toBe(false);
    expect(parseReviewOutput(undefined).ok).toBe(false);
    expect(parseReviewOutput([validOutput()]).ok).toBe(false);
  });

  it('rejects a missing summary even when everything else is fine', () => {
    const output = validOutput();
    delete output.summary;
    const parsed = parseReviewOutput(output);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBeTruthy();
  });

  it('rejects a missing prSummary', () => {
    const output = validOutput();
    delete output.prSummary;
    expect(parseReviewOutput(output).ok).toBe(false);
  });

  it('rejects a missing approved flag', () => {
    const output = validOutput();
    delete output.approved;
    expect(parseReviewOutput(output).ok).toBe(false);
  });
});

describe('parseReviewOutput — required arrays (no silent empty approval)', () => {
  it('rejects a missing lineComments array', () => {
    const output = validOutput();
    delete output.lineComments;
    const parsed = parseReviewOutput(output);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.toLowerCase()).toContain('linecomments');
  });

  it('rejects a missing criticalIssues array', () => {
    const output = validOutput();
    delete output.criticalIssues;
    expect(parseReviewOutput(output).ok).toBe(false);
  });

  it('rejects a missing suggestions array', () => {
    const output = validOutput();
    delete output.suggestions;
    expect(parseReviewOutput(output).ok).toBe(false);
  });

  it('accepts empty arrays — a genuinely clean review is valid', () => {
    const parsed = parseReviewOutput({ ...validOutput(), lineComments: [] });
    expect(parsed.ok).toBe(true);
  });

  it('resolvedComments and fileSummaries stay optional', () => {
    const parsed = parseReviewOutput({
      ...validOutput(),
      resolvedComments: [1, 2],
      fileSummaries: [{ path: 'a.ts', changeType: 'modified', summary: 'x' }],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('parseReviewOutput — lineComment contract', () => {
  function withComment(overrides: Record<string, unknown>) {
    return {
      ...validOutput(),
      approved: false,
      lineComments: [
        {
          path: 'src/api/users.ts',
          line: 15,
          side: 'RIGHT',
          severity: 'critical',
          issueKey: 'sql-injection',
          body: '🔴 **Issue:** concatenates user input into SQL',
          ...overrides,
        },
      ],
    };
  }

  it('accepts a well-formed critical comment', () => {
    expect(parseReviewOutput(withComment({})).ok).toBe(true);
  });

  it('rejects line 0 and negative lines', () => {
    expect(parseReviewOutput(withComment({ line: 0 })).ok).toBe(false);
    expect(parseReviewOutput(withComment({ line: -3 })).ok).toBe(false);
  });

  it('rejects non-integer lines', () => {
    expect(parseReviewOutput(withComment({ line: 12.5 })).ok).toBe(false);
    expect(parseReviewOutput(withComment({ line: '15' })).ok).toBe(false);
  });

  it('rejects invented severities', () => {
    expect(parseReviewOutput(withComment({ severity: 'medium' })).ok).toBe(false);
    expect(parseReviewOutput(withComment({ severity: 'blocker' })).ok).toBe(false);
  });

  it('rejects sides other than LEFT/RIGHT', () => {
    expect(parseReviewOutput(withComment({ side: 'BOTH' })).ok).toBe(false);
  });

  it('rejects an empty path or body', () => {
    expect(parseReviewOutput(withComment({ path: '' })).ok).toBe(false);
    expect(parseReviewOutput(withComment({ body: '' })).ok).toBe(false);
  });

  it('rejects comments whose issueKey cannot be derived', () => {
    const output = {
      ...validOutput(),
      lineComments: [
        {
          path: 'src/x.ts',
          line: 3,
          side: 'RIGHT',
          severity: 'suggestion',
          // no issueKey, no **Issue:** pattern in body → nothing to derive from
          body: 'Consider something.',
        },
      ],
    };
    const parsed = parseReviewOutput(output);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('issueKey');
  });

  it('derives the issueKey from a body pattern when the field is absent', () => {
    const output = {
      ...validOutput(),
      lineComments: [
        {
          path: 'src/x.ts',
          line: 3,
          side: 'RIGHT',
          severity: 'suggestion',
          body: '🔴 **Issue:** inverted-response-check breaks pagination',
        },
      ],
    };
    expect(parseReviewOutput(output).ok).toBe(true);
  });

  it('rejects an unknown entityType but tolerates its absence', () => {
    expect(parseReviewOutput(withComment({ entityType: 'namespace' })).ok).toBe(false);
    expect(parseReviewOutput(withComment({ entityType: undefined })).ok).toBe(true);
  });
});

describe('parseReviewOutput — reason strings stay quotable', () => {
  it('produces a non-empty, bounded reason for every invalid shape', () => {
    const base = validOutput();
    const invalids: unknown[] = [
      {},
      { approved: 1 },
      { approved: true, summary: 42 },
      { ...base, prSummary: { ...(base.prSummary as object), keyChanges: [] } },
      { ...base, lineComments: 'none' },
    ];
    for (const invalid of invalids) {
      const parsed = parseReviewOutput(invalid);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason.length).toBeGreaterThan(0);
        expect(parsed.reason.length).toBeLessThan(500);
      }
    }
  });
});
