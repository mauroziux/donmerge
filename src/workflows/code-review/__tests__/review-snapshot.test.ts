/**
 * Tests for review-snapshot.ts (plan 002-U1).
 *
 * Pagination stops on short pages, on the declared changed-file count, or on
 * GitHub's 3000-file hard cap — and a moved PR head invalidates the snapshot.
 */

import { describe, it, expect } from 'vitest';

import {
  GITHUB_PR_FILES_HARD_CAP,
  PR_FILES_MAX_PAGES,
  PR_FILES_PER_PAGE,
  PrHeadChangedError,
  buildPrFilesPageUrl,
  discoveryMatchesDeclared,
  shouldStopPaginating,
} from '../review-snapshot';

describe('shouldStopPaginating', () => {
  it('stops on a short page (last page reached)', () => {
    expect(
      shouldStopPaginating({ fetchedThisPage: 42, totalFetched: 42, declaredCount: 42, page: 1 })
    ).toBe(true);
  });

  it('stops when the declared changed-file count is covered', () => {
    expect(
      shouldStopPaginating({ fetchedThisPage: 100, totalFetched: 120, declaredCount: 120, page: 2 })
    ).toBe(true);
  });

  it('keeps paginating while below the declared count', () => {
    expect(
      shouldStopPaginating({ fetchedThisPage: 100, totalFetched: 100, declaredCount: 250, page: 1 })
    ).toBe(false);
  });

  it('stops at the API hard cap even if the PR declares more', () => {
    expect(
      shouldStopPaginating({
        fetchedThisPage: 100,
        totalFetched: GITHUB_PR_FILES_HARD_CAP,
        declaredCount: 4000,
        page: 30,
      })
    ).toBe(true);
  });

  it('stops on the defensive page ceiling', () => {
    expect(
      shouldStopPaginating({
        fetchedThisPage: PR_FILES_PER_PAGE,
        totalFetched: PR_FILES_MAX_PAGES * PR_FILES_PER_PAGE - PR_FILES_PER_PAGE,
        declaredCount: 999_999,
        page: PR_FILES_MAX_PAGES,
      })
    ).toBe(true);
  });
});

describe('discoveryMatchesDeclared', () => {
  it('true when discovery covers the declaration', () => {
    expect(discoveryMatchesDeclared(10, 10, false)).toBe(true);
    expect(discoveryMatchesDeclared(12, 10, false)).toBe(true);
  });

  it('false when discovery falls short', () => {
    expect(discoveryMatchesDeclared(8, 10, false)).toBe(false);
  });

  it('false when the API cap was reached, regardless of counts', () => {
    expect(discoveryMatchesDeclared(3000, 3000, true)).toBe(false);
  });

  it('trusts the listing when the declaration is unknown', () => {
    expect(discoveryMatchesDeclared(5, 0, false)).toBe(true);
  });
});

describe('buildPrFilesPageUrl', () => {
  it('renders per_page and page parameters', () => {
    expect(buildPrFilesPageUrl('owner', 'repo', 7, 3)).toBe(
      'https://api.github.com/repos/owner/repo/pulls/7/files?per_page=100&page=3'
    );
  });
});

describe('PrHeadChangedError', () => {
  it('carries both SHAs and a classifiable message', () => {
    const error = new PrHeadChangedError('aaa', 'bbb');
    expect(error.name).toBe('PrHeadChangedError');
    expect(error.expectedHeadSha).toBe('aaa');
    expect(error.actualHeadSha).toBe('bbb');
    expect(error.message).toContain('PR head changed');
  });
});
