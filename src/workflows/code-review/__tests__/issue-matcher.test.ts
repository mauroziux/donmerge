/**
 * Tests for issue-matcher.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchCurrentFindingsToStored,
  type CurrentIssue,
} from '../issue-matcher';
import { createTrackedIssue, resetIssueCounter } from './helpers';

describe('matchCurrentFindingsToStored', () => {
  beforeEach(() => {
    resetIssueCounter();
  });

  function makeCurrentIssue(
    overrides: Partial<CurrentIssue> = {}
  ): CurrentIssue {
    const payload = createTrackedIssue(overrides.payload);
    return {
      fingerprint: payload.fingerprint,
      logicalKey: payload.logicalKey,
      anchorKey: payload.anchorKey,
      payload,
      ...overrides,
    };
  }

  it('should classify all findings as new when nothing is stored', () => {
    const current = [makeCurrentIssue()];
    const result = matchCurrentFindingsToStored(current, []);
    expect(result.newIssues).toHaveLength(1);
    expect(result.persistingIssues).toHaveLength(0);
    expect(result.resolvedIssues).toHaveLength(0);
    expect(result.reintroducedIssues).toHaveLength(0);
  });

  it('should match by exact fingerprint and classify as persisting', () => {
    const stored = createTrackedIssue({ status: 'open' });
    const current = makeCurrentIssue({
      fingerprint: stored.fingerprint,
      logicalKey: 'different-logical',
      anchorKey: 'different-anchor',
    });

    const result = matchCurrentFindingsToStored([current], [stored]);
    expect(result.persistingIssues).toHaveLength(1);
    expect(result.newIssues).toHaveLength(0);
  });

  it('should fall back to logical key match', () => {
    const stored = createTrackedIssue({
      fingerprint: 'different-fp',
      status: 'open',
    });
    const current = makeCurrentIssue({
      fingerprint: 'new-fp',
      logicalKey: stored.logicalKey,
      anchorKey: 'different-anchor',
    });

    const result = matchCurrentFindingsToStored([current], [stored]);
    expect(result.persistingIssues).toHaveLength(1);
    expect(result.newIssues).toHaveLength(0);
  });

  it('should fall back to anchor key match', () => {
    const stored = createTrackedIssue({
      fingerprint: 'different-fp',
      logicalKey: 'different-logical',
      status: 'open',
    });
    const current = makeCurrentIssue({
      fingerprint: 'new-fp',
      logicalKey: 'new-logical',
      anchorKey: stored.anchorKey,
    });

    const result = matchCurrentFindingsToStored([current], [stored]);
    expect(result.persistingIssues).toHaveLength(1);
    expect(result.newIssues).toHaveLength(0);
  });

  it('should classify as reintroduced when stored issue is fixed', () => {
    const stored = createTrackedIssue({ status: 'fixed' });
    const current = makeCurrentIssue({
      fingerprint: stored.fingerprint,
    });

    const result = matchCurrentFindingsToStored([current], [stored]);
    expect(result.reintroducedIssues).toHaveLength(1);
    expect(result.newIssues).toHaveLength(0);
    expect(result.persistingIssues).toHaveLength(0);
  });

  it('should classify unmatched stored issues as resolved', () => {
    const stored1 = createTrackedIssue({ status: 'open' });
    const stored2 = createTrackedIssue({ status: 'new' });
    const stored3 = createTrackedIssue({ status: 'fixed' }); // fixed issues should NOT be in resolved

    const result = matchCurrentFindingsToStored([], [stored1, stored2, stored3]);
    expect(result.resolvedIssues).toHaveLength(2);
    expect(result.resolvedIssues.map((i) => i.id)).toContain(stored1.id);
    expect(result.resolvedIssues.map((i) => i.id)).toContain(stored2.id);
    expect(result.resolvedIssues.map((i) => i.id)).not.toContain(stored3.id);
  });

  it('should handle multiple current and stored issues', () => {
    const stored1 = createTrackedIssue({ status: 'open' });
    const stored2 = createTrackedIssue({
      status: 'open',
      anchorKey: 'src/api.ts|different snippet',
    });
    const stored3 = createTrackedIssue({
      status: 'new',
      anchorKey: 'src/utils.ts|yet another snippet',
    });

    const current1 = makeCurrentIssue({ fingerprint: stored1.fingerprint });
    const current2 = makeCurrentIssue({
      fingerprint: stored2.fingerprint,
      logicalKey: 'different-logical',
      anchorKey: 'different-anchor',
    });
    // current3 is genuinely new - different fingerprint, logicalKey, and anchorKey
    const current3 = makeCurrentIssue({
      fingerprint: 'brand-new-fp',
      logicalKey: 'brand-new-logical',
      anchorKey: 'brand-new-anchor',
    });

    const result = matchCurrentFindingsToStored(
      [current1, current2, current3],
      [stored1, stored2, stored3]
    );

    expect(result.persistingIssues).toHaveLength(2);
    expect(result.newIssues).toHaveLength(1);
    expect(result.resolvedIssues).toHaveLength(1);
    expect(result.reintroducedIssues).toHaveLength(0);
  });

  it('should not classify dismissed issues as resolved', () => {
    const stored = createTrackedIssue({ status: 'dismissed' });
    const result = matchCurrentFindingsToStored([], [stored]);
    expect(result.resolvedIssues).toHaveLength(0);
  });

  it('should handle empty inputs', () => {
    const result = matchCurrentFindingsToStored([], []);
    expect(result.newIssues).toHaveLength(0);
    expect(result.persistingIssues).toHaveLength(0);
    expect(result.resolvedIssues).toHaveLength(0);
    expect(result.reintroducedIssues).toHaveLength(0);
  });
});
