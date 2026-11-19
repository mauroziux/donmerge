/**
 * Tests for review-state.ts — per-PR last-reviewed-SHA persistence used by
 * incremental re-reviews (cost control).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getReviewState, recordReviewState } from '../review-state';

// ─── D1Database mock factory (same pattern as feedback-handler.test.ts) ──

function createMockDb(firstResult: Record<string, unknown> | null = null) {
  const mockFirst = vi.fn().mockResolvedValue(firstResult);
  const mockRun = vi.fn().mockResolvedValue({});
  const mockBind = vi.fn().mockReturnValue({ first: mockFirst, run: mockRun });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
  return {
    db: { prepare: mockPrepare } as unknown as D1Database,
    prepare: mockPrepare,
    bind: mockBind,
    first: mockFirst,
    run: mockRun,
  };
}

describe('getReviewState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no state row exists', async () => {
    const { db } = createMockDb(null);
    expect(await getReviewState(db, 'tableoltd', 'rms', 42)).toBeNull();
  });

  it('maps the row with fullCoverage as a boolean', async () => {
    const { db } = createMockDb({
      base_ref: 'develop',
      last_reviewed_sha: 'abc123',
      full_coverage: 1,
    });
    const state = await getReviewState(db, 'tableoltd', 'rms', 42);
    expect(state).toEqual({
      owner: 'tableoltd',
      repo: 'rms',
      prNumber: 42,
      baseRef: 'develop',
      baseSha: null,
      lastReviewedSha: 'abc123',
      fullCoverage: true,
    });
  });

  it('maps full_coverage=0 to fullCoverage=false', async () => {
    const { db } = createMockDb({
      base_ref: 'develop',
      last_reviewed_sha: 'abc123',
      full_coverage: 0,
    });
    const state = await getReviewState(db, 'tableoltd', 'rms', 42);
    expect(state?.fullCoverage).toBe(false);
  });

  it('scopes the lookup by owner, repo and PR number', async () => {
    const { db, prepare, bind } = createMockDb(null);
    await getReviewState(db, 'tableoltd', 'rms', 42);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith('tableoltd', 'rms', 42);
    expect(vi.mocked(prepare).mock.calls[0][0]).toContain('WHERE owner = ? AND repo = ? AND pr_number = ?');
  });
});

describe('recordReviewState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts with full coverage and the base ref', async () => {
    const { db, prepare, bind } = createMockDb(null);
    await recordReviewState(db, {
      owner: 'tableoltd',
      repo: 'rms',
      prNumber: 42,
      baseRef: 'develop',
      baseSha: 'base123',
      headSha: 'def456',
      fullCoverage: true,
    });

    expect(bind).toHaveBeenCalledWith('tableoltd', 'rms', 42, 'develop', 'base123', 'def456', 1);
    expect(vi.mocked(prepare).mock.calls[0][0]).toContain('ON CONFLICT(owner, repo, pr_number) DO UPDATE');
  });

  it('records partial coverage as fullCoverage=0', async () => {
    const { db, bind } = createMockDb(null);
    await recordReviewState(db, {
      owner: 'tableoltd',
      repo: 'rms',
      prNumber: 42,
      baseRef: 'develop',
      headSha: 'def456',
      fullCoverage: false,
    });
    expect(bind).toHaveBeenCalledWith('tableoltd', 'rms', 42, 'develop', null, 'def456', 0);
  });

  it('defaults the base ref to an empty string', async () => {
    const { db, bind } = createMockDb(null);
    await recordReviewState(db, {
      owner: 'tableoltd',
      repo: 'rms',
      prNumber: 42,
      headSha: 'def456',
      fullCoverage: true,
    });
    expect(bind).toHaveBeenCalledWith('tableoltd', 'rms', 42, '', null, 'def456', 1);
  });
});
