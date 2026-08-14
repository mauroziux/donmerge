/**
 * Tests for review-body-guard.ts — degenerate body detection and skip decision.
 */

import { describe, it, expect } from 'vitest';
import {
  isDegenerateReviewBody,
  DEGENERATE_BODY_FALLBACK,
  reviewSkipDecision,
} from '../review-body-guard';

describe('isDegenerateReviewBody', () => {
  it('flags an empty string', () => {
    expect(isDegenerateReviewBody('')).toBe(true);
  });

  it('flags a whitespace-only string', () => {
    expect(isDegenerateReviewBody('   \n\t  ')).toBe(true);
  });

  it('flags a short placeholder', () => {
    expect(isDegenerateReviewBody('test')).toBe(true);
    expect(isDegenerateReviewBody('foo')).toBe(true);
    expect(isDegenerateReviewBody('placeholder')).toBe(true);
  });

  it('flags a short body containing placeholder wording', () => {
    expect(isDegenerateReviewBody('temp review')).toBe(true);
    expect(isDegenerateReviewBody('dummy output')).toBe(true);
  });

  it('does NOT flag a substantive short-ish summary above the scan length', () => {
    // A real one-sentence summary longer than PLACEHOLDER_SCAN_LENGTH is fine
    // even if it happens to contain the word "test".
    const body =
      'The PR adds a new test harness for the billing service and refactors the invoice generator.';
    expect(isDegenerateReviewBody(body)).toBe(false);
  });

  it('does NOT flag a normal 2-sentence summary', () => {
    const body =
      'Clean implementation overall. The new auth check correctly rejects expired tokens before they reach the session store.';
    expect(isDegenerateReviewBody(body)).toBe(false);
  });

  it('treats the fallback body as non-degenerate (no infinite loop)', () => {
    expect(isDegenerateReviewBody(DEGENERATE_BODY_FALLBACK)).toBe(false);
  });
});

describe('reviewSkipDecision', () => {
  it('skips a non-approving review with no body and no comments', () => {
    const decision = reviewSkipDecision({ approved: false, body: '', hasComments: false });
    expect(decision?.kind).toBe('no-issues');
  });

  it('skips a non-approving review with whitespace-only body', () => {
    const decision = reviewSkipDecision({ approved: false, body: '   ', hasComments: false });
    expect(decision?.kind).toBe('no-issues');
  });

  it('does NOT skip a non-approving review with a body', () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: 'some summary',
      hasComments: false,
    });
    expect(decision).toBeNull();
  });

  it('does NOT skip a non-approving review with comments', () => {
    const decision = reviewSkipDecision({ approved: false, body: '', hasComments: true });
    expect(decision).toBeNull();
  });

  it('does NOT skip an empty approve (GitHub accepts empty APPROVE)', () => {
    const decision = reviewSkipDecision({ approved: true, body: '', hasComments: false });
    expect(decision).toBeNull();
  });

  it('does NOT skip an approve with content', () => {
    const decision = reviewSkipDecision({
      approved: true,
      body: 'LGTM',
      hasComments: true,
    });
    expect(decision).toBeNull();
  });
});
