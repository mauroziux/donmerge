/**
 * Per-PR review state in D1 (migration 0005).
 *
 * Records what was last reviewed and whether that review covered the whole PR
 * diff, so a retrigger can review only the commits since that SHA instead of
 * re-sending the whole accumulated diff to the model (cost control).
 *
 * Honest-coverage rule: incremental reviews are only built from a state whose
 * `fullCoverage` is true — the previous run's coverage manifest was
 * scopeComplete, so "unchanged files inherit the previous verdict" is grounded.
 */

export interface ReviewState {
  owner: string;
  repo: string;
  prNumber: number;
  /** PR base ref the recorded review ran against (retarget invalidates). */
  baseRef: string;
  baseSha: string | null;
  /** Reviewed head commit. */
  lastReviewedSha: string;
  /** True when the recorded review covered the whole PR diff (scopeComplete). */
  fullCoverage: boolean;
}

interface ReviewStateRow {
  base_ref: string;
  base_sha: string | null;
  last_reviewed_sha: string;
  full_coverage: number;
}

export async function getReviewState(
  db: D1Database,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewState | null> {
  const row = await db
    .prepare(
      `SELECT base_ref, base_sha, last_reviewed_sha, full_coverage
       FROM review_state
       WHERE owner = ? AND repo = ? AND pr_number = ?
       LIMIT 1`
    )
    .bind(owner, repo, prNumber)
    .first<ReviewStateRow>();
  if (!row) return null;
  return {
    owner,
    repo,
    prNumber,
    baseRef: row.base_ref,
    baseSha: row.base_sha ?? null,
    lastReviewedSha: row.last_reviewed_sha,
    fullCoverage: row.full_coverage === 1,
  };
}

/**
 * Upsert the review state for a PR.
 *
 * `fullCoverage` records whether the review at `headSha` covered the whole PR
 * diff (coverage manifest scopeComplete). Partial reviews overwrite the row
 * with fullCoverage = 0 so a later push cannot build an incremental review on
 * top of an incomplete verdict.
 */
export async function recordReviewState(
  db: D1Database,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    baseRef?: string;
    baseSha?: string;
    headSha: string;
    fullCoverage: boolean;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO review_state (owner, repo, pr_number, base_ref, base_sha, last_reviewed_sha, full_coverage, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(owner, repo, pr_number) DO UPDATE SET
         base_ref = excluded.base_ref,
         base_sha = excluded.base_sha,
         last_reviewed_sha = excluded.last_reviewed_sha,
         full_coverage = excluded.full_coverage,
         updated_at = datetime('now')`
    )
    .bind(
      input.owner,
      input.repo,
      input.prNumber,
      input.baseRef ?? '',
      input.baseSha ?? null,
      input.headSha,
      input.fullCoverage ? 1 : 0
    )
    .run();
}
