/**
 * Offline evaluation corpus types (plan 001-U1).
 *
 * The corpus replays RECORDED model outputs through the pipeline's real
 * post-processing (strict contract → quality gate → coverage/verdict) and
 * measures the mechanics: defect matching, gate behavior and verdict honesty.
 * It is a regression harness for pipeline changes — NOT a measure of live
 * model capability (that requires the labeled live eval, 001-U4).
 */

import type { ReviewComment } from '../types';

export type EvalSplit = 'dev' | 'holdout';

export interface KnownDefect {
  /** Stable kebab-case identity used for matching. */
  id: string;
  severity: 'critical' | 'high' | 'low';
  file: string;
  /** Expected line (RIGHT side) within ±10 lines. */
  lineHint?: number;
  description: string;
}

export interface EvalCase {
  id: string;
  name: string;
  origin: 'synthetic' | 'recorded';
  /** Split key: both sides of a buggy/fixed pair MUST share a group. */
  group: string;
  split: EvalSplit;
  diff: string;
  headSha: string;
  changedFilesCount: number;
  /** Ground truth. Empty + cleanLabel = hard clean case. */
  knownDefects: KnownDefect[];
  cleanLabel?: boolean;
  /** A critical defect that must NEVER be missed (gate for compare script). */
  sentinel?: boolean;
  /** Recorded model output replayed through the pipeline. */
  recordedOutput: unknown;
}

export interface PipelineVerdict {
  /** Parsed+normalized review that survived the contract and quality gate. */
  comments: ReviewComment[];
  /** True when parsing/validation failed (counts as execution failure). */
  invalidOutput: boolean;
}

export interface EvalCaseResult {
  caseId: string;
  detectedDefectIds: string[];
  missedDefectIds: string[];
  unmatchedComments: number;
  duplicateMatches: number;
  blockingComments: number;
  invalidOutput: boolean;
}

export interface DetectionTotals {
  cases: number;
  invalidOutputs: number;
  reportedComments: number;
  truePositives: number;
  duplicates: number;
  falsePositives: number;
  knownDefects: number;
  detectedDefects: number;
  criticalKnown: number;
  criticalDetected: number;
  cleanCases: number;
  cleanCasesWithBlocking: number;
  precision: number;
  recall: number;
  criticalRecall: number;
  cleanFalseAlarmRate: number;
}

export interface HonestyCase {
  id: string;
  description: string;
  discovered: Array<{ filename: string; patch?: string }>;
  changedFilesCount: number;
  apiFileCapReached: boolean;
  focusFiles?: string[];
  hasBlocking: boolean;
}

export interface HonestyTotals {
  cases: number;
  falseCleanVerdicts: number;
  verdicts: Array<{ id: string; conclusion: 'success' | 'neutral' | 'failure'; scopeComplete: boolean }>;
}

export interface EvaluationReport {
  evaluatorVersion: number;
  generatedAt: string;
  corpus: { cases: number; synthetic: number; recorded: number; holdout: number };
  detection: DetectionTotals;
  honesty: HonestyTotals;
  perCase: EvalCaseResult[];
  sentinelsLost: string[];
  /** True when every number comes from synthetic fixtures (regression only). */
  syntheticOnly: boolean;
}
