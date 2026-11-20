/**
 * Tests for review-state.ts — per-PR last-reviewed-SHA persistence used by
 * incremental re-reviews (cost control).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { getReviewState, recordReviewState } from '../review-state';

// ─── D1Database mock factory (same pattern as feedback-handler.test.ts) ──

function createMockDb(firstResult: Record<string, unknown> | null = null) {
  const mockFirst = vi.fn().mockResolvedValue(firstResult);
  const mockRun = vi.fn().mockResolvedValue({});
  const mockBind = vi.fn().mockReturnValue({ first: mockFirst, run: mockRun });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
  const mockBatch = vi.fn().mockResolvedValue([]);
  return {
    db: { prepare: mockPrepare, batch: mockBatch } as unknown as D1Database,
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
      incrementalEligible: false,
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
    expect(vi.mocked(prepare).mock.calls[0][0]).toContain('WHERE s.owner = ? AND s.repo = ? AND s.pr_number = ?');
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
      incrementalEligible: true,
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
      incrementalEligible: false,
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
      incrementalEligible: true,
    });
    expect(bind).toHaveBeenCalledWith('tableoltd', 'rms', 42, '', null, 'def456', 1);
  });
});

describe('clean incremental baseline persistence', () => {
  function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync('migrations/0005_create_review_state.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0006_review_state_base_sha.sql', 'utf8'));
    sqlite.prepare(`INSERT INTO review_state
      (owner, repo, pr_number, base_ref, base_sha, last_reviewed_sha, full_coverage)
      VALUES ('org', 'repo', 1, 'main', 'base', 'legacy-head', 1)`).run();
    sqlite.exec(readFileSync('migrations/0011_clean_incremental_baselines.sql', 'utf8'));
    class Statement {
      values: (string | number | null)[] = [];
      constructor(readonly sql: string) {}
      bind(...values: (string | number | null)[]) { this.values = values; return this; }
      async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
    }
    const db = {
      prepare: (sql: string) => new Statement(sql),
      batch: async (statements: Statement[]) => {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map(statement => sqlite.prepare(statement.sql).run(...statement.values));
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as D1Database;
    return { sqlite, db };
  }
  const clean = { owner: 'org', repo: 'repo', prNumber: 1, baseRef: 'main', baseSha: 'base',
    headSha: 'head-1', fullCoverage: true, incrementalEligible: true };

  it('requires a new clean review and invalidates the marker after any legacy write', async () => {
    const { sqlite, db } = fixture();
    try {
      expect(await getReviewState(db, 'org', 'repo', 1)).toMatchObject({ fullCoverage: true, incrementalEligible: false });
      await recordReviewState(db, clean);
      expect(await getReviewState(db, 'org', 'repo', 1)).toMatchObject({ lastReviewedSha: 'head-1', fullCoverage: true, incrementalEligible: true });
      // Simulate the old Worker's same-SHA SQL, including a replay of the same values.
      sqlite.prepare("UPDATE review_state SET last_reviewed_sha = 'head-1', full_coverage = 1 WHERE owner = 'org' AND repo = 'repo' AND pr_number = 1").run();
      expect(await getReviewState(db, 'org', 'repo', 1)).toMatchObject({ fullCoverage: true, incrementalEligible: false });
      await recordReviewState(db, clean);
      await recordReviewState(db, { ...clean, headSha: 'head-2', incrementalEligible: false });
      expect(await getReviewState(db, 'org', 'repo', 1)).toMatchObject({ lastReviewedSha: 'head-2', fullCoverage: true, incrementalEligible: false });
      await recordReviewState(db, { ...clean, headSha: 'head-3', fullCoverage: false });
      expect(await getReviewState(db, 'org', 'repo', 1)).toMatchObject({ fullCoverage: false, incrementalEligible: false });
    } finally {
      sqlite.close();
    }
  });

  it('rolls back the state and prior marker if writing the new marker fails', async () => {
    const { sqlite, db } = fixture();
    try {
      await recordReviewState(db, clean);
      sqlite.exec(`CREATE TRIGGER reject_test_baseline BEFORE INSERT ON review_incremental_baselines
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      await expect(recordReviewState(db, { ...clean, headSha: 'head-2' })).rejects.toThrow('injected failure');
      expect(await getReviewState(db, 'org', 'repo', 1)).toMatchObject({ lastReviewedSha: 'head-1', incrementalEligible: true });
    } finally {
      sqlite.close();
    }
  });
});
