import { findDonmergeReviewComment, type FetchedReviewComment } from './github-api';

export interface FindingForMemory {
  fingerprint: string;
  logicalKey: string;
  payload: {
    ruleId: string;
    filePath: string;
    line: number;
    severity: 'critical' | 'suggestion' | 'low';
    body: string;
    status: string;
  };
}

export interface ReviewOutcomeInput {
  fingerprint: string;
  logicalKey: string;
  ruleId: string;
  filePath: string;
  line: number;
  severity: 'critical' | 'suggestion' | 'low';
  body: string;
  status: string;
  githubCommentId?: number;
}

/**
 * Link findings to only their exact, DonMerge-authored inline comment.
 * Unmatched comments remain without an ID and cannot be used as trust anchors
 * for future feedback; callers must not fall back to unverified cached IDs.
 */
export function buildReviewOutcomeInputs(
  findings: FindingForMemory[],
  publishedComments: FetchedReviewComment[]
): ReviewOutcomeInput[] {
  return findings.map((finding) => {
    const comment = findDonmergeReviewComment(
      publishedComments,
      finding.payload.filePath,
      finding.fingerprint
    );
    return {
      fingerprint: finding.fingerprint,
      logicalKey: finding.logicalKey,
      ruleId: finding.payload.ruleId,
      filePath: finding.payload.filePath,
      line: finding.payload.line,
      severity: finding.payload.severity,
      body: finding.payload.body,
      status: finding.payload.status,
      githubCommentId: comment?.id,
    };
  });
}
