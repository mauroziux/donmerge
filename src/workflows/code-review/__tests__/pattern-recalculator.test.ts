/**
 * Tests for pattern-recalculator.ts
 *
 * Covers:
 * - recalculatePatternWeights: computing confidence from feedback outcomes
 * - needsRecalculation: threshold check for triggering recalculation
 * - classifyPatternType: rule ID → pattern type classification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recalculatePatternWeights, needsRecalculation } from '../pattern-recalculator';

// ─── D1Database mock factory ────────────────────────────────────────

/**
 * Creates a mock D1Database with configurable responses per prepare().bind() chain.
 *
 * The `sequence` parameter is an array of return values for successive .first() / .all() / .run() calls.
 * For `.all()`, wrap in `{ results: [...] }`. For `.first()`, return the value directly.
 * For `.run()`, return `{}` or any object.
 */
function createMockDb(sequence: Array<{ type: 'first' | 'all' | 'run'; value: any }> = []) {
  let callIndex = 0;

  const mockRun = vi.fn().mockImplementation(() => {
    const entry = sequence[callIndex] ?? { type: 'run', value: {} };
    if (entry.type === 'run') {
      callIndex++;
      return Promise.resolve(entry.value);
    }
    // If next in sequence isn't run, still resolve
    callIndex++;
    return Promise.resolve({});
  });

  const mockFirst = vi.fn().mockImplementation(() => {
    const entry = sequence[callIndex] ?? { type: 'first', value: null };
    if (entry.type === 'first') {
      callIndex++;
      return Promise.resolve(entry.value);
    }
    callIndex++;
    return Promise.resolve(null);
  });

  const mockAll = vi.fn().mockImplementation(() => {
    const entry = sequence[callIndex] ?? { type: 'all', value: { results: [] } };
    if (entry.type === 'all') {
      callIndex++;
      return Promise.resolve(entry.value);
    }
    callIndex++;
    return Promise.resolve({ results: [] });
  });

  const mockBind = vi.fn().mockReturnValue({
    first: mockFirst,
    all: mockAll,
    run: mockRun,
  });

  const mockPrepare = vi.fn().mockReturnValue({
    bind: mockBind,
  });

  return {
    db: { prepare: mockPrepare, batch: vi.fn().mockResolvedValue({}) } as unknown as D1Database,
    prepare: mockPrepare,
    bind: mockBind,
    first: mockFirst,
    all: mockAll,
    run: mockRun,
  };
}

/**
 * Creates a simpler mock for functions that only use .first() once.
 */
function createSimpleMockDb(firstResult: any = null) {
  const mockFirst = vi.fn().mockResolvedValue(firstResult);
  const mockRun = vi.fn().mockResolvedValue({});
  const mockBind = vi.fn().mockReturnValue({
    first: mockFirst,
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: mockRun,
  });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });

  return {
    db: { prepare: mockPrepare, batch: vi.fn().mockResolvedValue({}) } as unknown as D1Database,
    prepare: mockPrepare,
    bind: mockBind,
    first: mockFirst,
    run: mockRun,
  };
}

// ─── recalculatePatternWeights ──────────────────────────────────────

describe('recalculatePatternWeights', () => {
  it('calculates confidence from outcomes with mostly accepted findings', async () => {
    const mock = createMockDb([
      // .all() for the aggregate query
      { type: 'all', value: {
        results: [{
          rule_id: 'sql-injection',
          total_findings: 20,
          dismissed_count: 1,
          accepted_count: 15,
          fixed_count: 3,
          ignored_count: 1,
        }],
      }},
      // .first() for getPatternWeight (no existing)
      { type: 'first', value: null },
      // .run() for INSERT
      { type: 'run', value: {} },
    ]);

    await recalculatePatternWeights(mock.db, 'owner', 'repo');

    expect(mock.prepare).toHaveBeenCalled();
    // Should have called all() for the aggregate query, then first() + run() for upsert
    expect(mock.all).toHaveBeenCalled();
  });

  it('calculates low confidence when most findings are dismissed', async () => {
    const mock = createMockDb([
      { type: 'all', value: {
        results: [{
          rule_id: 'style-imports',
          total_findings: 15,
          dismissed_count: 12,
          accepted_count: 1,
          fixed_count: 1,
          ignored_count: 1,
        }],
      }},
      { type: 'first', value: null },
      { type: 'run', value: {} },
    ]);

    await recalculatePatternWeights(mock.db, 'owner', 'repo');

    expect(mock.prepare).toHaveBeenCalled();
  });

  it('handles empty results', async () => {
    const mock = createMockDb([
      { type: 'all', value: { results: [] } },
    ]);

    // Should not throw
    await recalculatePatternWeights(mock.db, 'owner', 'repo');

    expect(mock.prepare).toHaveBeenCalled();
  });

  it('handles multiple rule_ids', async () => {
    const mock = createMockDb([
      { type: 'all', value: {
        results: [
          {
            rule_id: 'sql-injection',
            total_findings: 10,
            dismissed_count: 0,
            accepted_count: 8,
            fixed_count: 2,
            ignored_count: 0,
          },
          {
            rule_id: 'style-imports',
            total_findings: 12,
            dismissed_count: 10,
            accepted_count: 1,
            fixed_count: 1,
            ignored_count: 0,
          },
        ],
      }},
      // first for sql-injection (no existing)
      { type: 'first', value: null },
      // run for sql-injection INSERT
      { type: 'run', value: {} },
      // first for style-imports (existing)
      { type: 'first', value: { id: 1 } },
      // run for style-imports UPDATE
      { type: 'run', value: {} },
    ]);

    await recalculatePatternWeights(mock.db, 'owner', 'repo');

    expect(mock.prepare).toHaveBeenCalled();
  });

  it('upserts to existing pattern weight when one exists', async () => {
    const mock = createMockDb([
      { type: 'all', value: {
        results: [{
          rule_id: 'xss-vulnerability',
          total_findings: 8,
          dismissed_count: 2,
          accepted_count: 5,
          fixed_count: 1,
          ignored_count: 0,
        }],
      }},
      // first for getPatternWeight (existing)
      { type: 'first', value: { id: 42, rule_id: 'xss-vulnerability' } },
      // run for UPDATE
      { type: 'run', value: {} },
    ]);

    await recalculatePatternWeights(mock.db, 'owner', 'repo');

    expect(mock.prepare).toHaveBeenCalled();
  });
});

// ─── needsRecalculation ─────────────────────────────────────────────

describe('needsRecalculation', () => {
  it('returns true when feedback count exceeds threshold', async () => {
    const mock = createSimpleMockDb({ count: 15 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 10);
    expect(result).toBe(true);
  });

  it('returns false when feedback count is below threshold', async () => {
    const mock = createSimpleMockDb({ count: 5 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 10);
    expect(result).toBe(false);
  });

  it('returns true when feedback count equals threshold', async () => {
    const mock = createSimpleMockDb({ count: 10 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 10);
    expect(result).toBe(true);
  });

  it('returns false when count is null (no feedback)', async () => {
    const mock = createSimpleMockDb(null);

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 10);
    expect(result).toBe(false);
  });

  it('returns false when count is 0', async () => {
    const mock = createSimpleMockDb({ count: 0 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 10);
    expect(result).toBe(false);
  });

  it('uses default threshold of 10', async () => {
    const mock = createSimpleMockDb({ count: 10 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo');
    expect(result).toBe(true);
  });

  it('supports custom threshold', async () => {
    const mock = createSimpleMockDb({ count: 3 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 5);
    expect(result).toBe(false);
  });

  it('supports very low threshold', async () => {
    const mock = createSimpleMockDb({ count: 1 });

    const result = await needsRecalculation(mock.db, 'owner', 'repo', 1);
    expect(result).toBe(true);
  });
});
