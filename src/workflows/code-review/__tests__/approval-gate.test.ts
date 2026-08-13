/**
 * Tests for approval-gate.ts — outstanding-threads approval gate.
 */

import { describe, it, expect } from 'vitest';
import {
  countOutstandingDonmergeThreads,
  applyApprovalGate,
} from '../approval-gate';
import type { PreviousComment, ReviewResult } from '../types';

function makeComment(overrides: Partial<PreviousComment> = {}): PreviousComment {
  return {
    id: 1,
    path: 'src/a.ts',
    line: 10,
    body: 'issue',
    resolved: false,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    approved: true,
    summary: 'All good, compadre!',
    lineComments: [],
    criticalIssues: [],
    suggestions: [],
    ...overrides,
  };
}

describe('countOutstandingDonmergeThreads', () => {
  it('counts unresolved comments', () => {
    const comments = [
      makeComment({ id: 1, resolved: false }),
      makeComment({ id: 2, resolved: false }),
      makeComment({ id: 3, resolved: true }),
    ];
    expect(countOutstandingDonmergeThreads(comments)).toBe(2);
  });

  it('treats undefined resolved as unresolved', () => {
    const comments = [makeComment({ id: 1, resolved: undefined })];
    expect(countOutstandingDonmergeThreads(comments)).toBe(1);
  });

  it('returns 0 when all resolved', () => {
    const comments = [
      makeComment({ id: 1, resolved: true }),
      makeComment({ id: 2, resolved: true }),
    ];
    expect(countOutstandingDonmergeThreads(comments)).toBe(0);
  });

  it('returns 0 for empty list', () => {
    expect(countOutstandingDonmergeThreads([])).toBe(0);
  });
});

describe('applyApprovalGate', () => {
  it('does nothing when review is already non-approving', () => {
    const review = makeReview({ approved: false });
    const result = applyApprovalGate(review, [makeComment({ resolved: false })]);
    expect(result.overridden).toBe(false);
    expect(result.review.approved).toBe(false);
    expect(result.outstandingCount).toBe(0);
  });

  it('does not override an approve when no outstanding threads', () => {
    const review = makeReview({ approved: true });
    const result = applyApprovalGate(review, []);
    expect(result.overridden).toBe(false);
    expect(result.review.approved).toBe(true);
    expect(result.review.summary).toBe('All good, compadre!');
  });

  it('does not override an approve when all prior threads resolved', () => {
    const review = makeReview({ approved: true });
    const comments = [makeComment({ resolved: true })];
    const result = applyApprovalGate(review, comments);
    expect(result.overridden).toBe(false);
    expect(result.review.approved).toBe(true);
  });

  it('downgrades an approve when outstanding threads exist', () => {
    const review = makeReview({ approved: true });
    const comments = [
      makeComment({ id: 1, resolved: false }),
      makeComment({ id: 2, resolved: false }),
    ];
    const result = applyApprovalGate(review, comments);
    expect(result.overridden).toBe(true);
    expect(result.review.approved).toBe(false);
    expect(result.outstandingCount).toBe(2);
  });

  it('appends the reason to the summary when overriding', () => {
    const review = makeReview({ approved: true, summary: 'Looks great.' });
    const result = applyApprovalGate(review, [makeComment({ resolved: false })]);
    expect(result.review.summary).toContain('Looks great.');
    expect(result.review.summary).toContain('Approval withheld');
    expect(result.review.summary).toContain('1 prior DonMerge review thread');
  });

  it('uses the reason as the summary when original is empty', () => {
    const review = makeReview({ approved: true, summary: '' });
    const result = applyApprovalGate(review, [makeComment({ resolved: false })]);
    expect(result.review.summary).toBe(result.reason);
  });

  it('never throws', () => {
    const review = makeReview({ approved: true });
    expect(() => applyApprovalGate(review, [])).not.toThrow();
  });
});
