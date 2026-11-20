/**
 * Per-PR review state in D1 (migration 0005).
 *
 * Records what was last reviewed and whether that review covered the whole PR
 * diff, so a retrigger can review only the commits since that SHA instead of
 * re-sending the whole accumulated diff to the model (cost control).
 *
 * Incremental reviews require both full coverage and a separately recorded
 * clean baseline for the same snapshot. A full review with a blocking finding
 * or an unresolved thread cannot certify unchanged files as clean later.
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
  /** A complete, clean review established a reusable baseline for this snapshot. */
  incrementalEligible: boolean;
}

interface ReviewStateRow {
  base_ref: string;
  base_sha: string | null;
  last_reviewed_sha: string;
  full_coverage: number;
  incremental_eligible: number;
}

export async function getReviewState(
  db: D1Database,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewState | null> {
  const row = await db
    .prepare(
      `SELECT s.base_ref, s.base_sha, s.last_reviewed_sha, s.full_coverage,
              CASE WHEN b.pr_number IS NULL THEN 0 ELSE 1 END AS incremental_eligible
       FROM review_state s
       LEFT JOIN review_incremental_baselines b
         ON b.owner = s.owner AND b.repo = s.repo AND b.pr_number = s.pr_number
        AND b.base_ref = s.base_ref AND b.base_sha = s.base_sha AND b.head_sha = s.last_reviewed_sha
       WHERE s.owner = ? AND s.repo = ? AND s.pr_number = ?
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
    incrementalEligible: row.incremental_eligible === 1,
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
    incrementalEligible: boolean;
  }
): Promise<void> {
  const state = db.prepare(
      `INSERT INTO review_state (owner, repo, pr_number, base_ref, base_sha, last_reviewed_sha, full_coverage, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(owner, repo, pr_number) DO UPDATE SET
         base_ref = excluded.base_ref,
         base_sha = excluded.base_sha,
         last_reviewed_sha = excluded.last_reviewed_sha,
         full_coverage = excluded.full_coverage,
         updated_at = datetime('now')`
    ).bind(
      input.owner,
      input.repo,
      input.prNumber,
      input.baseRef ?? '',
      input.baseSha ?? null,
      input.headSha,
      input.fullCoverage ? 1 : 0
    );
  // The trigger clears any prior marker on every write, including writes made
  // by an older Worker. This batch restores it only for an eligible snapshot.
  const statements = [state, db.prepare(`DELETE FROM review_incremental_baselines
    WHERE owner = ? AND repo = ? AND pr_number = ?`).bind(input.owner, input.repo, input.prNumber)];
  if (input.fullCoverage && input.incrementalEligible && input.baseRef && input.baseSha && input.headSha) {
    statements.push(db.prepare(`INSERT INTO review_incremental_baselines
      (owner, repo, pr_number, base_ref, base_sha, head_sha) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(input.owner, input.repo, input.prNumber, input.baseRef, input.baseSha, input.headSha));
  }
  await db.batch(statements);
}
