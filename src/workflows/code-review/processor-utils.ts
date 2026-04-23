/**
 * Pure logic extracted from ReviewProcessor for testability.
 *
 * These functions contain no side effects (no fetch, no storage, no crypto.subtle
 * except where already tested elsewhere). The ReviewProcessor orchestrates these
 * with its Durable Object state and GitHub API calls.
 */

import type {
  ReviewComment,
  ReviewResult,
  PreviousComment,
  PRSummary,
} from './types';
import { deriveIssueKey, extractIssueTerms, buildIssueIdentity } from './issue-key';
import { getSeverityOverride } from './donmerge';

/**
 * Validate required fields from LLM output.
 */
export function validateReviewResult(
  result: ReviewResult
): { valid: boolean; reason?: string } {
  if (!result || typeof result !== 'object') {
    return { valid: false, reason: 'result is not an object' };
  }

  if (!result.summary || typeof result.summary !== 'string' || !result.summary.trim()) {
    return { valid: false, reason: 'missing summary' };
  }

  const prSummary = result.prSummary as PRSummary | undefined;
  if (!prSummary || typeof prSummary !== 'object') {
    return { valid: false, reason: 'missing prSummary' };
  }

  if (!prSummary.overview?.trim()) return { valid: false, reason: 'missing prSummary.overview' };
  if (!Array.isArray(prSummary.keyChanges) || prSummary.keyChanges.length === 0) {
    return { valid: false, reason: 'missing prSummary.keyChanges' };
  }
  if (!prSummary.codeQuality?.trim()) return { valid: false, reason: 'missing prSummary.codeQuality' };
  if (!prSummary.testingNotes?.trim()) return { valid: false, reason: 'missing prSummary.testingNotes' };
  if (!prSummary.riskAssessment?.trim()) return { valid: false, reason: 'missing prSummary.riskAssessment' };

  const criticalIssues = Array.isArray(result.criticalIssues) ? result.criticalIssues : [];
  const lineComments = Array.isArray(result.lineComments) ? result.lineComments : [];

  for (const comment of lineComments) {
    if (!deriveIssueKey(comment)) {
      return { valid: false, reason: 'lineComment missing issueKey' };
    }
  }

  if (criticalIssues.length > 0 && lineComments.length === 0) {
    return { valid: false, reason: 'criticalIssues present but lineComments empty' };
  }

  return { valid: true };
}

/**
 * Normalize and validate the review result.
 * Derives issue keys, reconciles with previous comments, normalizes prSummary.
 */
export function normalizeReviewResult(
  result: ReviewResult,
  previousComments?: PreviousComment[],
  severityOverrides?: Record<string, 'critical' | 'suggestion' | 'low'>
): ReviewResult {
  const lineComments = Array.isArray(result.lineComments)
    ? result.lineComments.map((comment) => ({
        ...comment,
        issueKey: deriveIssueKey(comment),
      }))
    : [];
  const reconciledLineComments = reconcileIssueKeys(lineComments, previousComments ?? []);

  // Apply severity overrides from .donmerge config
  const finalLineComments = severityOverrides
    ? reconciledLineComments.map((comment) => {
        const override = getSeverityOverride(comment.path, severityOverrides);
        if (override) {
          return { ...comment, severity: override };
        }
        return comment;
      })
    : reconciledLineComments;

  const criticalIssues = Array.isArray(result.criticalIssues) ? result.criticalIssues : [];

  const hasLineComments = finalLineComments.length > 0;
  const hasCriticalIssues = criticalIssues.length > 0;
  const approved = !hasLineComments && !hasCriticalIssues;

  // Normalize prSummary
  let prSummary: PRSummary | undefined;
  if (result.prSummary && typeof result.prSummary === 'object') {
    prSummary = {
      overview: result.prSummary.overview ?? 'No overview provided.',
      keyChanges: Array.isArray(result.prSummary.keyChanges) ? result.prSummary.keyChanges : [],
      codeQuality: result.prSummary.codeQuality ?? 'Not assessed.',
      testingNotes: result.prSummary.testingNotes ?? 'No testing notes provided.',
      riskAssessment: result.prSummary.riskAssessment ?? 'Not assessed.',
    };
  }

  const derivedSummary = prSummary
    ? `${prSummary.overview}${prSummary.riskAssessment ? ` Risk: ${prSummary.riskAssessment}` : ''}`
    : 'Review completed.';

  return {
    approved,
    summary: result.summary ?? derivedSummary,
    prSummary,
    lineComments: finalLineComments,
    criticalIssues,
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    resolvedComments: [],
    fileSummaries: Array.isArray(result.fileSummaries) ? result.fileSummaries : [],
  };
}

/**
 * Filter comments to only include new and reintroduced issues.
 */
export function filterCommentsByMatch(
  comments: ReviewComment[],
  currentFingerprints: string[],
  currentLogicalKeys: string[],
  newFingerprints: string[],
  reintroducedLogicalKeys: string[]
): ReviewComment[] {
  if (currentFingerprints.length === 0) {
    return comments;
  }

  const newFpSet = new Set(newFingerprints);
  const reintroducedKeySet = new Set(reintroducedLogicalKeys);

  const commentByFingerprint = new Map<string, ReviewComment>();
  for (let i = 0; i < currentFingerprints.length; i += 1) {
    commentByFingerprint.set(currentFingerprints[i], comments[i]);
  }

  const filtered: ReviewComment[] = [];
  for (let i = 0; i < currentFingerprints.length; i += 1) {
    const fp = currentFingerprints[i];
    const lk = currentLogicalKeys[i];
    const comment = commentByFingerprint.get(fp);
    if (!comment) continue;

    if (newFpSet.has(fp)) {
      filtered.push(comment);
      continue;
    }

    if (reintroducedKeySet.has(lk)) {
      filtered.push(comment);
    }
  }

  return filtered;
}

/**
 * Calculate overlap score between two term sets.
 */
export function calculateIssueOverlapScore(
  previousTerms: string[],
  currentTerms: string[]
): number {
  if (previousTerms.length === 0 || currentTerms.length === 0) {
    return 0;
  }

  const previousSet = new Set(previousTerms);
  const currentSet = new Set(currentTerms);
  let overlap = 0;

  for (const term of currentSet) {
    if (previousSet.has(term)) {
      overlap += 1;
    }
  }

  return overlap / Math.min(previousSet.size, currentSet.size);
}

/**
 * Check if two term sets have strong overlap.
 */
export function hasStrongIssueTextOverlap(
  previousTerms: string[],
  currentTerms: string[]
): boolean {
  if (previousTerms.length === 0 || currentTerms.length === 0) {
    return false;
  }

  const previousSet = new Set(previousTerms);
  let overlap = 0;
  for (const term of currentTerms) {
    if (previousSet.has(term)) {
      overlap += 1;
    }
  }

  const baseline = Math.min(previousSet.size, new Set(currentTerms).size);
  return overlap >= 2 && overlap / baseline >= 0.5;
}

/**
 * Reconcile issue keys between current comments and previous comments.
 * If a current comment matches a previous comment, reuse the previous issueKey
 * for stable identity across re-runs.
 */
export function reconcileIssueKeys(
  lineComments: ReviewResult['lineComments'],
  previousComments: PreviousComment[]
): ReviewResult['lineComments'] {
  if (lineComments.length === 0 || previousComments.length === 0) {
    return lineComments;
  }

  const availablePrevious = previousComments.filter((comment) => !comment.resolved);

  return lineComments.map((comment) => {
    const matchedPrevious = findPersistingPreviousComment(comment, availablePrevious);
    if (!matchedPrevious?.issueKey) {
      return comment;
    }

    return {
      ...comment,
      issueKey: matchedPrevious.issueKey,
    };
  });
}

/**
 * Find a persisting previous comment that matches the current comment.
 */
function findPersistingPreviousComment(
  currentComment: ReviewResult['lineComments'][number],
  previousComments: PreviousComment[]
): PreviousComment | undefined {
  const currentPath = currentComment.path.trim().toLowerCase();
  const currentTerms = extractIssueTerms(currentComment.body);
  const currentIdentity = buildIssueIdentity(currentComment.path, currentComment.issueKey);

  const sameFileComments = previousComments.filter(
    (comment) => comment.path.trim().toLowerCase() === currentPath
  );

  // First pass: exact identity match
  for (const previousComment of sameFileComments) {
    const previousIdentity = buildIssueIdentity(previousComment.path, previousComment.issueKey);
    if (currentIdentity && previousIdentity && currentIdentity === previousIdentity) {
      return previousComment;
    }
  }

  // Second pass: score-based matching
  const scoredMatches = sameFileComments
    .map((previousComment) => {
      const previousTerms = extractIssueTerms(previousComment.body);
      const overlapScore = calculateIssueOverlapScore(previousTerms, currentTerms);
      const lineDistance = Math.abs((previousComment.line || 0) - currentComment.line);

      return { previousComment, overlapScore, lineDistance };
    })
    .filter((match) => match.overlapScore >= 0.5)
    .sort((a, b) => {
      if (b.overlapScore !== a.overlapScore) {
        return b.overlapScore - a.overlapScore;
      }
      return a.lineDistance - b.lineDistance;
    });

  return scoredMatches[0]?.previousComment;
}

/**
 * Sync tracked issues from previous comments by matching issue text.
 * Updates githubCommentId on stored issues that match previous comments.
 */
export function syncTrackedIssuesFromComments(
  storedIssues: import('./types').TrackedIssue[],
  previousComments: PreviousComment[]
): import('./types').TrackedIssue[] {
  if (storedIssues.length === 0 || previousComments.length === 0) {
    return storedIssues;
  }

  return storedIssues.map((issue) => {
    if (issue.githubCommentId) {
      return issue;
    }

    const issueTerms = extractIssueTerms(issue.body);
    const matching = previousComments.find((comment) => {
      if (issue.filePath !== comment.path) {
        return false;
      }

      if (
        comment.ruleId &&
        issue.ruleId === comment.ruleId &&
        comment.symbolName &&
        issue.symbolName === comment.symbolName
      ) {
        return true;
      }

      if (
        comment.issueKey &&
        (issue.ruleId === comment.issueKey || issue.logicalKey.startsWith(`${comment.issueKey}|`))
      ) {
        return true;
      }

      const commentTerms = extractIssueTerms(comment.body);
      return hasStrongIssueTextOverlap(issueTerms, commentTerms);
    });

    if (!matching) {
      return issue;
    }

    return {
      ...issue,
      githubCommentId: matching.id,
    };
  });
}
