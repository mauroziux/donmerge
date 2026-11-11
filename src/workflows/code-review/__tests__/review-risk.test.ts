/**
 * Tests for review-risk.ts (plan 003-U4).
 *
 * Deterministic, explainable risk signals; `unknown` when there is nothing to
 * assess so missing data can never downgrade review depth to "low".
 */

import { describe, it, expect } from 'vitest';

import { assessPrRisk, shouldRunSecondPass } from '../review-risk';

describe('assessPrRisk', () => {
  it('returns unknown with no files (never a silent low)', () => {
    expect(assessPrRisk([])).toEqual({ level: 'unknown', reasons: ['no files to assess'] });
  });

  it('marks auth/migration/payment paths as high risk', () => {
    const result = assessPrRisk([
      { filename: 'app/Http/Controllers/AuthController.php', patch: '+public function login() {}' },
      { filename: 'database/migrations/2026_add_orders_table.php', patch: '+Schema::create(...)' },
    ]);

    expect(result.level).toBe('high');
    expect(result.reasons).toContain('auth/authorization surface');
    expect(result.reasons).toContain('schema or data migration');
  });

  it('detects risk from patch content even on innocuous paths', () => {
    const result = assessPrRisk([
      {
        filename: 'src/services/booking.ts',
        patch: '+await db.transaction(async () => { await retry(createBooking); });',
      },
    ]);

    expect(result.level).toBe('high');
    expect(result.reasons).toContain('transaction semantics');
    expect(result.reasons).toContain('retry/idempotency');
  });

  it('credentials and raw queries escalate', () => {
    const result = assessPrRisk([
      { filename: 'lib/utils.ts', patch: '+const apiKey = process.env.KEY; +db.query(`SELECT ${id}`)' },
    ]);

    expect(result.level).toBe('high');
    expect(result.reasons).toContain('credential handling');
    expect(result.reasons).toContain('raw query/execution');
  });

  it('docs-only changes stay low risk', () => {
    const result = assessPrRisk([{ filename: 'docs/README.md', patch: '+clarified setup' }]);

    expect(result.level).toBe('low');
    expect(result.reasons).toEqual(['no high-risk signals matched']);
  });
});

describe('shouldRunSecondPass', () => {
  it('runs for a high-risk change whose review is clean', () => {
    expect(shouldRunSecondPass({ level: 'high', reasons: [] }, false)).toBe(true);
  });

  it('runs for unknown risk — missing data never skips depth', () => {
    expect(shouldRunSecondPass({ level: 'unknown', reasons: [] }, false)).toBe(true);
  });

  it('skips when blocking findings already gate the merge', () => {
    expect(shouldRunSecondPass({ level: 'high', reasons: [] }, true)).toBe(false);
  });

  it('skips for a low-risk clean change (adaptive, not maximal)', () => {
    expect(shouldRunSecondPass({ level: 'low', reasons: [] }, false)).toBe(false);
  });
});
