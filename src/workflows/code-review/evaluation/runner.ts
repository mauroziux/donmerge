/**
 * Offline evaluation runner (plan 001-U2/U4).
 *
 * Replays recorded outputs through the pipeline's REAL deterministic stages:
 *   parseReviewOutput (strict contract) → normalizeReviewResult (quality
 *   gate) → matchCommentsToDefects (detection) → checkConclusion × coverage
 *   (verdict honesty).
 *
 * No network, no models, no flakiness. The report is a regression gate for
 * pipeline changes; synthetic-only corpora are marked as such because they
 * say nothing about live model capability.
 */

import type { ReviewComment } from '../types';
import { normalizeReviewResult } from '../processor-utils';
import { parseReviewOutput } from '../review-output-schema';
import {
  buildCoverageManifest,
  checkConclusion,
  planReviewFiles,
  DEFAULT_DIFF_CHAR_BUDGET,
} from '../review-coverage';
import type {
  DetectionTotals,
  EvalCase,
  EvalCaseResult,
  EvaluationReport,
  HonestyCase,
  HonestyTotals,
  PipelineVerdict,
} from './corpus';
import { matchCommentsToDefects } from './matcher';

export const EVALUATOR_VERSION = 1;

/** Run one recorded output through contract + quality gate. */
export function replayThroughPipeline(recordedOutput: unknown): PipelineVerdict {
  const parsed = parseReviewOutput(recordedOutput);
  if (!parsed.ok) {
    return { comments: [], invalidOutput: true };
  }
  const normalized = normalizeReviewResult(parsed.value);
  return { comments: normalized.lineComments, invalidOutput: false };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function evaluateDetection(cases: EvalCase[]): { totals: DetectionTotals; perCase: EvalCaseResult[]; sentinelsLost: string[] } {
  const perCase: EvalCaseResult[] = [];
  const sentinelsLost: string[] = [];

  let reportedComments = 0;
  let truePositives = 0;
  let duplicates = 0;
  let falsePositives = 0;
  let knownDefects = 0;
  let detectedDefects = 0;
  let criticalKnown = 0;
  let criticalDetected = 0;
  let cleanCases = 0;
  let cleanCasesWithBlocking = 0;
  let invalidOutputs = 0;

  for (const testCase of cases) {
    const verdict = replayThroughPipeline(testCase.recordedOutput);
    const match = matchCommentsToDefects(verdict.comments, testCase.knownDefects);
    const blocking = verdict.comments.filter((c) => c.severity === 'critical').length;

    if (verdict.invalidOutput) invalidOutputs += 1;
    reportedComments += verdict.comments.length;
    truePositives += match.detected.length;
    duplicates += match.duplicates;
    falsePositives += match.unmatchedComments;
    knownDefects += testCase.knownDefects.length;
    detectedDefects += match.detected.length;

    const criticalDefects = testCase.knownDefects.filter((d) => d.severity === 'critical');
    criticalKnown += criticalDefects.length;
    criticalDetected += criticalDefects.filter((d) => match.detected.includes(d)).length;

    if (testCase.cleanLabel) {
      cleanCases += 1;
      if (blocking > 0) cleanCasesWithBlocking += 1;
    }

    for (const defect of testCase.knownDefects) {
      if (defect.severity === 'critical' && !match.detected.includes(defect)) {
        sentinelsLost.push(`${testCase.id}:${defect.id}`);
      }
    }

    perCase.push({
      caseId: testCase.id,
      detectedDefectIds: match.detected.map((d) => d.id),
      missedDefectIds: match.missed.map((d) => d.id),
      unmatchedComments: match.unmatchedComments,
      duplicateMatches: match.duplicates,
      blockingComments: blocking,
      invalidOutput: verdict.invalidOutput,
    });
  }

  return {
    perCase,
    sentinelsLost,
    totals: {
      cases: cases.length,
      invalidOutputs,
      reportedComments,
      truePositives,
      duplicates,
      falsePositives,
      knownDefects,
      detectedDefects,
      criticalKnown,
      criticalDetected,
      cleanCases,
      cleanCasesWithBlocking,
      precision: ratio(truePositives, truePositives + falsePositives),
      recall: ratio(detectedDefects, knownDefects),
      criticalRecall: ratio(criticalDetected, criticalKnown),
      cleanFalseAlarmRate: ratio(cleanCasesWithBlocking, cleanCases),
    },
  };
}

function evaluateHonesty(cases: HonestyCase[]): HonestyTotals {
  const verdicts: HonestyTotals['verdicts'] = [];
  let falseCleanVerdicts = 0;

  for (const testCase of cases) {
    const plan = planReviewFiles({
      discovered: testCase.discovered,
      focusFiles: testCase.focusFiles,
      isExcluded: () => false,
      maxFiles: 50,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });
    const coverage = buildCoverageManifest(plan, {
      headSha: 'eval',
      changedFilesCount: testCase.changedFilesCount,
      apiFileCapReached: testCase.apiFileCapReached,
    });
    const conclusion = checkConclusion(testCase.hasBlocking, coverage);

    if (!coverage.scopeComplete && !testCase.hasBlocking && conclusion === 'success') {
      falseCleanVerdicts += 1; // impossible by construction, but guard the gate
    }

    verdicts.push({ id: testCase.id, conclusion, scopeComplete: coverage.scopeComplete });
  }

  return { cases: cases.length, falseCleanVerdicts, verdicts };
}

/** Run the full offline evaluation and produce the report. */
export function runEvaluation(corpus: EvalCase[], honestyCases: HonestyCase[]): EvaluationReport {
  const detection = evaluateDetection(corpus);
  const honesty = evaluateHonesty(honestyCases);

  return {
    evaluatorVersion: EVALUATOR_VERSION,
    generatedAt: new Date().toISOString(),
    corpus: {
      cases: corpus.length,
      synthetic: corpus.filter((c) => c.origin === 'synthetic').length,
      recorded: corpus.filter((c) => c.origin === 'recorded').length,
      holdout: corpus.filter((c) => c.split === 'holdout').length,
    },
    detection: detection.totals,
    honesty,
    perCase: detection.perCase,
    sentinelsLost: detection.sentinelsLost,
    syntheticOnly: corpus.every((c) => c.origin === 'synthetic'),
  };
}

/** Gate for CI: fails on sentinel loss, false-clean verdicts or gate regressions. */
export function evaluationGate(report: EvaluationReport): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (report.sentinelsLost.length > 0) {
    failures.push(`sentinel defects lost: ${report.sentinelsLost.join(', ')}`);
  }
  if (report.honesty.falseCleanVerdicts > 0) {
    failures.push(`false-clean verdicts: ${report.honesty.falseCleanVerdicts}`);
  }
  if (report.detection.precision < 1) {
    failures.push(`precision regressed below 1.0 on synthetic corpus: ${report.detection.precision}`);
  }
  if (report.detection.criticalRecall < 1) {
    failures.push(`critical recall regressed below 1.0 on synthetic corpus: ${report.detection.criticalRecall}`);
  }
  if (report.detection.cleanFalseAlarmRate > 0) {
    failures.push(`clean cases produced blocking findings: ${report.detection.cleanCasesWithBlocking}`);
  }
  if (report.detection.invalidOutputs > 0) {
    failures.push(`recorded outputs rejected by the contract: ${report.detection.invalidOutputs}`);
  }
  return { pass: failures.length === 0, failures };
}

export type { ReviewComment };
