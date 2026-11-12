/**
 * Deterministic Cloudflare Workflow instance IDs for code reviews.
 *
 * A regular PR event keeps one stable instance per PR. A comment-triggered
 * re-review gets its own instance keyed by the GitHub comment ID, so it runs
 * with the fresh webhook payload (installation credentials, focus files, and
 * instructions) rather than restarting an old instance with stale params.
 *
 * GitHub delivers a given webhook at least once, so the same comment ID must
 * always produce the same ID for duplicate delivery recovery.
 */
export function buildReviewWorkflowInstanceId(
  owner: string,
  repo: string,
  prNumber: number,
  commentId?: number
): string {
  const baseId = `review-${owner}-${repo}-${prNumber}`;

  if (typeof commentId === 'number' && Number.isInteger(commentId) && commentId > 0) {
    return `${baseId}-comment-${commentId}`;
  }

  return baseId;
}

/**
 * Run-scoped workflow instance id (plan 004-U1): each started run gets its
 * OWN instance, so a `restart` can never resurrect a previous run's stale
 * params. The base id stays available for legacy instances created before
 * run fencing existed.
 */
export function buildRunScopedInstanceId(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number | undefined,
  runId: string | undefined
): string {
  const baseId = buildReviewWorkflowInstanceId(owner, repo, prNumber, commentId);
  if (!runId) return baseId; // legacy: no run identity available
  return `${baseId}-run-${runId.slice(0, 8)}`;
}
