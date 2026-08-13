/**
 * Approval gate based on outstanding DonMerge-originated review threads.
 *
 * DonMerge must never post an approving ("all good") review while any review
 * thread it previously raised remains unresolved on the PR — even when the
 * current diff is clean. A prior unresolved thread means a known issue is still
 * open; approving anyway signals "mergeable" when it is not.
 *
 * This gate counts unresolved DonMerge threads from the already-fetched
 * `activePreviousComments` (step 2 fetches and pre-filters them to unresolved +
 * DonMerge-authored). When the LLM would approve but outstanding threads exist,
 * the verdict is downgraded: the review posts as REQUEST_CHANGES instead of
 * COMMENT, and a note is appended to the summary so the reason is visible.
 *
 * The gate degrades, never blocks: it never throws, so a gating decision never
 * loses the valid new findings the run produced. Adapted from pullfrog's
 * `countOutstandingPullfrogThreads` (mcp/review.ts), rewritten for DonMerge's
 * REST-fetched PreviousComment shape (no GraphQL, no author-login re-check — the
 * fetch already filters by author).
 */

import type { PreviousComment, ReviewResult } from './types';

/**
 * Count unresolved DonMerge-originated review threads from the active previous
 * comments. `activePreviousComments` is pre-filtered in step 2 to unresolved +
 * DonMerge-authored, so this is a defensive count of entries where
 * `resolved !== true`. Kept as an explicit function so the gate reads as intent
 * and remains correct if the pre-filter ever changes.
 */
export function countOutstandingDonmergeThreads(comments: PreviousComment[]): number {
  return comments.filter((c) => c.resolved !== true).length;
}

export interface ApprovalGateResult {
  /** The review, with approved possibly downgraded to false. */
  review: ReviewResult;
  /** Number of outstanding DonMerge threads at decision time. */
  outstandingCount: number;
  /** True iff the verdict was downgraded from approve to non-approve. */
  overridden: boolean;
  /** Human-readable reason when overridden; empty otherwise. */
  reason: string;
}

/**
 * If the review would approve but outstanding DonMerge threads exist, downgrade
 * `approved` to false and append a note to the summary. Returns the (possibly
 * modified) review plus gating metadata. Never throws.
 *
 * Note on the event mapping: in DonMerge, `approved=true` posts a non-blocking
 * COMMENT ("all good") and `approved=false` posts REQUEST_CHANGES (blocking).
 * Downgrading to false therefore BLOCKS the merge until the prior threads are
 * resolved — which is exactly the intent ("don't merge while our issues are
 * open"). The check-run conclusion is driven by `hasBlockingFindings`, not by
 * `approved`, so a clean current diff keeps a green check-run; only the review
 * verdict flips to blocking.
 */
export function applyApprovalGate(
  review: ReviewResult,
  activePreviousComments: PreviousComment[]
): ApprovalGateResult {
  if (!review.approved) {
    return { review, outstandingCount: 0, overridden: false, reason: '' };
  }

  const outstanding = countOutstandingDonmergeThreads(activePreviousComments);
  if (outstanding === 0) {
    return { review, outstandingCount: 0, overridden: false, reason: '' };
  }

  const reason =
    `🤠 Approval withheld: ${outstanding} prior DonMerge review thread(s) are still unresolved. ` +
    `Please address or dismiss them, then re-run DonMerge. The current diff itself is clean.`;

  return {
    review: {
      ...review,
      approved: false,
      // Append the reason so it surfaces in both the posted review body and the
      // check-run summary. Prefix with a separator to keep it distinct.
      summary: review.summary.trim().length > 0
        ? `${review.summary.trim()}\n\n---\n${reason}`
        : reason,
    },
    outstandingCount: outstanding,
    overridden: true,
    reason,
  };
}
