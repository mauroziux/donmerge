/**
 * Guards for the review body and submission decision.
 *
 * Two concerns:
 *
 * 1. **Degenerate body** (isDegenerateReviewBody): a weak or confused LLM can
 *    emit a placeholder-like summary (`"test"`, `"placeholder"`, `""`). Every
 *    successful POST /reviews publishes a permanent, publicly visible review
 *    that no DonMerge tool can retract, so a placeholder probe is unrecoverable.
 *    This predicate catches them before the POST; the caller substitutes a safe
 *    fallback summary.
 *
 * 2. **Empty submission** (reviewSkipDecision): a run that found nothing still
 *    builds a payload. An empty APPROVE is legitimate (GitHub accepts it and it
 *    signals "no issues"), but an empty COMMENT review 422s. This decides
 *    whether to skip the POST entirely and let the check-run carry the verdict.
 *
 * Adapted from pullfrog's `isDegenerateReviewBody` + `reviewSkipDecision`
 * (mcp/review.ts), rewritten in DonMerge's plain-TS idiom.
 */

/**
 * Shortest body we accept without question. Calibrated to clear real DonMerge
 * summaries (which are 1-2 sentences) while rejecting observed placeholders.
 * `Simple review body` (18) is the longest observed placeholder; real summaries
 * are well above this.
 */
const MIN_BODY_LENGTH = 20;

/**
 * Placeholder wording that, combined with a short length, marks a body as
 * degenerate. Matched only against short bodies so a real review discussing a
 * test file is never at risk.
 */
const PLACEHOLDER_PATTERN = /\b(test|testing|placeholder|temp|foo|bar|asdf|dummy|sample|lorem)\b/i;

/** Bodies below this length are scanned for placeholder wording. */
const PLACEHOLDER_SCAN_LENGTH = 50;

/**
 * True iff the body looks like placeholder or diagnostic text rather than a
 * real review summary. An empty/whitespace body is always degenerate.
 */
export function isDegenerateReviewBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < MIN_BODY_LENGTH) return true;
  return trimmed.length < PLACEHOLDER_SCAN_LENGTH && PLACEHOLDER_PATTERN.test(trimmed);
}

/**
 * Safe fallback summary used when the LLM-produced summary is degenerate.
 * The review still posts (with any valid inline comments), but never with the
 * placeholder text itself.
 */
export const DEGENERATE_BODY_FALLBACK =
  '🤠 DonMerge completed the review but produced limited output. See the check-run for details.';

export interface ReviewSkipInput {
  approved: boolean;
  body: string | null | undefined;
  hasComments: boolean;
}

export type ReviewSkipDecision =
  | { kind: 'no-issues'; reason: string }
  | { kind: 'empty-approve'; reason: string };

/**
 * Decide whether to skip a review submission before any network call.
 *
 * - Returns `{ kind: 'no-issues' }` when the run is non-approving AND has no
 *   body AND no inline comments. This shape would POST an empty COMMENT review,
 *   which GitHub 422s. Skipping preserves the intent (nothing to post) without
 *   the spurious error; the check-run still reports success.
 * - Returns `{ kind: 'empty-approve' }` (informational) when approving with no
 *   body and no comments. DonMerge POSTs an empty APPROVE today and GitHub
 *   accepts it, so this is NOT a hard skip — but callers may use it to decide
 *   whether to attach a default approval body. Currently treated as non-skipping
 *   (returns null) to preserve existing behavior; kept here for parity/future use.
 * - Returns `null` to submit normally.
 */
export function reviewSkipDecision(input: ReviewSkipInput): ReviewSkipDecision | null {
  const hasBody = Boolean(input.body && input.body.trim().length > 0);
  if (hasBody || input.hasComments) return null;

  if (!input.approved) {
    return {
      kind: 'no-issues',
      reason:
        'this review carried neither a body nor inline comments, so nothing was posted. ' +
        'if no issues were found, the check-run carries the verdict — do not retry. ' +
        'if a review was intended, the LLM dropped the summary field.',
    };
  }
  // Empty APPROVE: GitHub accepts it, so do not skip. Return null to submit.
  return null;
}
