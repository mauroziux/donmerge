/**
 * Strict LLM review-output contract (plan 002-U3).
 *
 * This is the single structural validator for model output. An output that
 * does not satisfy the contract goes to the format-repair path (or fails the
 * model) — it can NEVER be silently normalized into an empty, approved
 * review. "The summary looks fine" is not validity: the arrays, enums, line
 * numbers and comment fields are required exactly as the prompt schema
 * promises.
 *
 * Back-compat note: processor-utils.validateReviewResult delegates here, so
 * the reason strings for the historical failure cases are preserved.
 */

import * as v from 'valibot';

import type { ReviewResult } from './types';
import { deriveIssueKey } from './issue-key';

const nonEmpty = (message: string) => v.pipe(v.string(message), v.nonEmpty(message));

export const ReviewCommentSchema = v.object({
  path: nonEmpty('lineComment missing path'),
  line: v.pipe(
    v.number('lineComment line must be a number'),
    v.integer('lineComment line must be an integer'),
    v.minValue(1, 'lineComment line must be a positive line number')
  ),
  side: v.picklist(['LEFT', 'RIGHT'], 'lineComment side must be LEFT or RIGHT'),
  body: nonEmpty('lineComment missing body'),
  severity: v.picklist(
    ['critical', 'suggestion', 'low'],
    'lineComment severity must be one of critical, suggestion, low'
  ),
  issueKey: v.optional(nonEmpty('lineComment missing issueKey')),
  ruleId: v.optional(v.string()),
  entityType: v.optional(
    v.picklist(
      ['method', 'function', 'class', 'variable', 'module'],
      'lineComment entityType must be method, function, class, variable or module'
    )
  ),
  symbolName: v.optional(v.string()),
  codeSnippet: v.optional(v.string()),
});

export const PrSummarySchema = v.object(
  {
    overview: nonEmpty('missing prSummary.overview'),
    keyChanges: v.pipe(
      v.array(v.string()),
      v.minLength(1, 'missing prSummary.keyChanges')
    ),
    codeQuality: nonEmpty('missing prSummary.codeQuality'),
    testingNotes: nonEmpty('missing prSummary.testingNotes'),
    riskAssessment: nonEmpty('missing prSummary.riskAssessment'),
  },
  'missing prSummary'
);

/**
 * Required: approved, summary, prSummary, lineComments, criticalIssues,
 * suggestions. Optional: resolvedComments, fileSummaries (they carry no
 * blocking semantics). Everything else the model emits is ignored.
 */
export const ReviewOutputSchema = v.object(
  {
    approved: v.boolean('approved must be a boolean'),
    summary: nonEmpty('missing summary'),
    prSummary: PrSummarySchema,
    lineComments: v.array(ReviewCommentSchema, 'missing lineComments'),
    criticalIssues: v.array(v.string(), 'missing criticalIssues'),
    suggestions: v.array(v.string(), 'missing suggestions'),
    resolvedComments: v.optional(v.array(v.number())),
    fileSummaries: v.optional(
      v.array(
        v.object({
          path: v.string(),
          changeType: v.picklist(['added', 'modified', 'deleted', 'renamed']),
          summary: v.string(),
        })
      )
    ),
  },
  'review output must be an object'
);

export type ParsedReviewOutput =
  | { ok: true; value: ReviewResult }
  | { ok: false; reason: string };

function formatIssuePath(issue: { path?: Array<{ key: unknown }>; message: string }): string {
  const path = issue.path?.map((entry) => String(entry.key)).join('.');
  return path ? `${issue.message} (at ${path})` : issue.message;
}

/**
 * Validate an untrusted review output (already JSON-parsed) against the
 * strict contract. Never throws: failures come back as a reason string the
 * format-retry prompt can quote.
 */
export function parseReviewOutput(raw: unknown): ParsedReviewOutput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'result is not an object' };
  }

  const result = v.safeParse(ReviewOutputSchema, raw);
  if (!result.success) {
    const reasons = result.issues
      .slice(0, 5)
      .map(formatIssuePath)
      .join('; ');
    return { ok: false, reason: reasons || 'invalid review output' };
  }

  const value = result.output as unknown as ReviewResult;

  // Identity requirement (kept from the historical validator): every comment
  // must carry a derivable issueKey — either explicit or derivable from its
  // body — so tracking across re-runs stays stable.
  for (const comment of value.lineComments) {
    if (!deriveIssueKey(comment)) {
      return { ok: false, reason: 'lineComment missing issueKey' };
    }
  }

  return { ok: true, value };
}
