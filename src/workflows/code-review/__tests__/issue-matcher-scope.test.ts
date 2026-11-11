/**
 * Tests for issue-matcher scope semantics (plan 002-U4).
 *
 * A partial/focused review must not interpret "stored issue not observed" as
 * "issue fixed": the file holding the issue may never have been reviewed.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { matchCurrentFindingsToStored, type CurrentIssue } from '../issue-matcher';
import { createTrackedIssue, resetIssueCounter } from './helpers';

function currentIssue(overrides: Partial<CurrentIssue> = {}): CurrentIssue {
  const tracked = createTrackedIssue({
    filePath: 'src/a.ts',
    ruleId: 'null-deref',
    line: 10,
  });
  return {
    fingerprint: tracked.fingerprint,
    logicalKey: tracked.logicalKey,
    anchorKey: tracked.anchorKey,
    payload: tracked,
    ...overrides,
  };
}

beforeEach(() => {
  resetIssueCounter();
});

describe('matchCurrentFindingsToStored — assumeMissingResolved', () => {
  it('default (full scope): unmatched open issues become resolved', () => {
    const stored = [createTrackedIssue({ filePath: 'src/a.ts', status: 'open' })];

    const result = matchCurrentFindingsToStored([], stored);

    expect(result.resolvedIssues.map((i) => i.id)).toEqual([stored[0].id]);
  });

  it('partial scope: unmatched open issues stay untouched (not assessed)', () => {
    const stored = [createTrackedIssue({ filePath: 'src/a.ts', status: 'open' })];

    const result = matchCurrentFindingsToStored([], stored, { assumeMissingResolved: false });

    expect(result.resolvedIssues).toEqual([]);
    // The caller keeps the stored state as-is (no transition emitted).
  });

  it('partial scope: observed matches still transition normally', () => {
    const stored = [createTrackedIssue({ filePath: 'src/a.ts', status: 'open' })];
    const finding = currentIssue({ fingerprint: stored[0].fingerprint });

    const result = matchCurrentFindingsToStored([finding], stored, {
      assumeMissingResolved: false,
    });

    expect(result.persistingIssues.map((i) => i.id)).toEqual([stored[0].id]);
    expect(result.newIssues).toEqual([]);
  });

  it('partial scope: a previously fixed issue that reappears is still reintroduced', () => {
    const stored = [createTrackedIssue({ filePath: 'src/a.ts', status: 'fixed' })];
    const finding = currentIssue({ fingerprint: stored[0].fingerprint });

    const result = matchCurrentFindingsToStored([finding], stored, {
      assumeMissingResolved: false,
    });

    expect(result.reintroducedIssues.map((i) => i.id)).toEqual([stored[0].id]);
  });

  it('partial scope: dismissed issues never become resolved either way', () => {
    const stored = [createTrackedIssue({ filePath: 'src/a.ts', status: 'dismissed' })];

    const full = matchCurrentFindingsToStored([], stored);
    const partial = matchCurrentFindingsToStored([], stored, { assumeMissingResolved: false });

    expect(full.resolvedIssues).toEqual([]);
    expect(partial.resolvedIssues).toEqual([]);
  });
});
