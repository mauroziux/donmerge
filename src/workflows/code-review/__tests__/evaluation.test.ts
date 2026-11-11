/**
 * Offline evaluation gate (plan 001-U4).
 *
 * Runs the synthetic corpus through the real deterministic pipeline stages
 * and enforces the regression gates:
 *   - zero sentinel critical defects lost
 *   - zero false-clean verdicts (coverage honesty)
 *   - precision / critical recall at 1.0 on the synthetic corpus
 *   - zero blocking findings manufactured on clean cases
 *   - zero recorded outputs rejected by the strict contract
 *
 * With EVAL_REPORT_DIR set, writes evaluation-report.json for the compare
 * script (`npm run eval:review:compare`). Synthetic corpora are marked as
 * such in the report: this is a regression harness, not live-model proof.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SYNTHETIC_CORPUS, HONESTY_CASES } from '../evaluation/fixtures';
import { evaluationGate, runEvaluation } from '../evaluation/runner';
import { matchCommentsToDefects } from '../evaluation/matcher';
import { replayThroughPipeline } from '../evaluation/runner';
import type { ReviewComment } from '../types';

const report = runEvaluation(SYNTHETIC_CORPUS, HONESTY_CASES);

describe('evaluation — detection metrics (synthetic corpus)', () => {
  it('detects every known defect, including sentinels', () => {
    expect(report.detection.knownDefects).toBe(5);
    expect(report.detection.detectedDefects).toBe(5);
    expect(report.detection.recall).toBe(1);
    expect(report.detection.criticalKnown).toBe(3);
    expect(report.detection.criticalDetected).toBe(3);
    expect(report.detection.criticalRecall).toBe(1);
    expect(report.sentinelsLost).toEqual([]);
  });

  it('counts duplicate restatements separately (precision not inflated)', () => {
    expect(report.detection.duplicates).toBe(1);
    expect(report.detection.truePositives).toBe(5);
    expect(report.detection.precision).toBe(1);
  });

  it('proximity+term-overlap matching works when issueKeys diverge', () => {
    const tenantCase = report.perCase.find((c) => c.caseId === 'tenant-scope-buggy');
    expect(tenantCase?.detectedDefectIds).toContain('missing-restaurant-scope');
  });

  it('clean cases stay clean: the gate drops advisory-only bait', () => {
    expect(report.detection.cleanCases).toBeGreaterThanOrEqual(5);
    expect(report.detection.cleanCasesWithBlocking).toBe(0);
    expect(report.detection.cleanFalseAlarmRate).toBe(0);

    const bait = SYNTHETIC_CORPUS.find((c) => c.id === 'clean-advisory-bait')!;
    const replay = replayThroughPipeline(bait.recordedOutput);
    expect(replay.comments).toHaveLength(0);
  });

  it('every recorded output satisfies the strict contract', () => {
    expect(report.detection.invalidOutputs).toBe(0);
  });
});

describe('evaluation — verdict honesty', () => {
  it('never returns a green success for a partial scope', () => {
    expect(report.honesty.falseCleanVerdicts).toBe(0);

    const byId = new Map(report.honesty.verdicts.map((v) => [v.id, v]));
    expect(byId.get('full-clean')).toMatchObject({ conclusion: 'success', scopeComplete: true });
    expect(byId.get('budget-truncated')?.conclusion).toBe('neutral');
    expect(byId.get('focused-subset')?.conclusion).toBe('neutral');
    expect(byId.get('no-patch-file')?.conclusion).toBe('neutral');
    expect(byId.get('api-cap')?.conclusion).toBe('neutral');
    expect(byId.get('blocking-partial')?.conclusion).toBe('failure');
  });
});

describe('evaluation — matcher edge cases', () => {
  function rc(overrides: Partial<ReviewComment>): ReviewComment {
    return {
      path: 'f.ts',
      line: 1,
      side: 'RIGHT',
      severity: 'critical',
      body: '',
      ...overrides,
    };
  }

  it('paraphrased comments detect the defect via term overlap + proximity', () => {
    const result = matchCommentsToDefects(
      [rc({ path: 'src/a.ts', line: 15, body: 'this duplicates the reservation booking when retried' })],
      [
        {
          id: 'missing-idempotency-key',
          severity: 'critical',
          file: 'src/a.ts',
          lineHint: 12,
          description: 'missing idempotency key duplicates the booking on webhook retry',
        },
      ]
    );
    expect(result.detected).toHaveLength(1);
  });

  it('same file, different defect, far line → no match', () => {
    const result = matchCommentsToDefects(
      [rc({ path: 'src/a.ts', line: 400, body: 'unrelated note about logging verbosity' })],
      [
        {
          id: 'missing-idempotency-key',
          severity: 'critical',
          file: 'src/a.ts',
          lineHint: 12,
          description: 'missing idempotency key duplicates the booking on webhook retry',
        },
      ]
    );
    expect(result.detected).toHaveLength(0);
    expect(result.unmatchedComments).toBe(1);
  });

  it('an empty comment set misses everything but fabricates nothing', () => {
    const result = matchCommentsToDefects(
      [],
      [
        {
          id: 'x',
          severity: 'low',
          file: 'a.ts',
          description: 'd',
        },
      ]
    );
    expect(result.missed).toHaveLength(1);
    expect(result.unmatchedComments).toBe(0);
  });
});

describe('evaluation — gate and report', () => {
  it('the regression gate passes on the shipped corpus', () => {
    const gate = evaluationGate(report);
    expect(gate.failures).toEqual([]);
    expect(gate.pass).toBe(true);
  });

  it('the gate fails loudly on a sentinel loss', () => {
    const broken = {
      ...report,
      sentinelsLost: ['booking-idempotency-buggy:missing-idempotency-key'],
    };
    const gate = evaluationGate(broken);
    expect(gate.pass).toBe(false);
    expect(gate.failures[0]).toContain('sentinel');
  });

  it('marks the report as synthetic-only (not live-model proof)', () => {
    expect(report.syntheticOnly).toBe(true);
    expect(report.corpus.synthetic).toBe(SYNTHETIC_CORPUS.length);
  });

  it('writes evaluation-report.json when EVAL_REPORT_DIR is set', () => {
    const dir = process.env.EVAL_REPORT_DIR;
    if (!dir) return; // default local run: no artifact
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'evaluation-report.json'), JSON.stringify(report, null, 2));
  });
});
