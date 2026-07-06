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
  PatternWeight,
} from './types';
import { deriveIssueKey, extractIssueTerms, buildIssueIdentity } from './issue-key';
import { getSeverityOverride } from './donmerge';

const STYLE_NOISE_PATTERNS = [
  /\b(imports?|exports?)\b.{0,32}\b(alphabetical|alphabetic|sorted|order|ordering|organize)\b/i,
  /\b(alphabetical|alphabetic|sorted|order|ordering|organize)\b.{0,32}\b(imports?|exports?)\b/i,
  /\bphpdoc\b|\bdocblock\b|\b@return\b|\b@throws\b|\b@param\b/i,
  /\b(indentation|indent|whitespace|spacing|formatting|prettier|lint|linting|trailing comma|trailing commas|semicolon|semicolons)\b/i,
  /\b(comment cleanup|cleanup comments?|remove stale comments?|delete unused comments?|unnecessary comments?|redundant comments?)\b/i,
  /\b(naming convention|rename (this )?(variable|function|method|class|property)|better name|more descriptive name)\b/i,
  /\b(refactor|cleanup|clean up|tidy|readability|style nit|nitpick)\b/i,
];

const ADVISORY_WORD_PATTERN = /\b(ensure|verify|consider|test|confirm|double-check|double check|may|might|could)\b/i;

const CRITICAL_DOMAIN_PATTERN = /\b(sql injection|sql query|sql|xss|csrf|ssrf|injection|auth(?:entication|orization)?|permission|access control|privilege|secret|token|password|credential|api key|data loss|corrupt(?:ion)?|truncate|delete|runtime error|exception|crash|null|undefined|race|deadlock|concurren(?:cy|t)|regression|broken logic|wrong result|incorrect result|n\+1|infinite loop|memory leak|timeout|critical performance)\b/i;

const CONCRETE_FAILURE_PATTERN = /\b(leads? to|leading to|causes?|causing|results? in|resulting in|allows?|allowing|enables?|enabling|permits?|permitting|exposes?|exposing|throws?|crashes?|fails?|breaks?|loses?|corrupts?|leaks?|bypasses?|rejects?|accepts?|dereferences?|overwrites?|drops?|deadlocks?|hangs?|times? out|panics?|raises?)\b/i;
const CONCRETE_FAILURE_STATE_PATTERN = /\b(runtime error|exception|crash|null dereference|null pointer|undefined property|data loss|data corruption|race condition|security bypass|authentication bypass|authorization bypass|privilege escalation|credential exposure|secret exposure|incorrect result|wrong result|deadlock|infinite loop|memory leak|timeout)\b/i;
const CONCRETE_VULNERABILITY_MECHANISM_PATTERN = /\b(vulnerab(?:le|ility)|bypass(?:es|ed|ing)?|inject(?:s|ed|ing)?|directly concatenated|concatenat(?:es?|ed|ing)|user input|untrusted input|attacker-controlled|unsanitized|unescaped|unvalidated)\b/i;

/**
 * Fix LLM double-escaped newlines in comment body.
 *
 * The LLM sometimes outputs \\n (JSON double-escape) inside code blocks,
 * which JSON.parse() turns into the literal two-character string \n instead
 * of a real newline. Replace with actual newlines.
 */
export function normalizeCommentBody(body: string): string {
  return body.replace(/\\n/g, '\n');
}

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

  const lineComments = Array.isArray(result.lineComments) ? result.lineComments : [];

  for (const comment of lineComments) {
    if (!deriveIssueKey(comment)) {
      return { valid: false, reason: 'lineComment missing issueKey' };
    }
  }

  return { valid: true };
}

/**
 * True when a normalized review result has blocking findings.
 * Only verified critical inline findings or explicit criticalIssues block merges.
 */
export function hasBlockingFindings(review: Pick<ReviewResult, 'lineComments' | 'criticalIssues'>): boolean {
  const hasCriticalLineComment = Array.isArray(review.lineComments)
    ? filterLineCommentsByQuality(review.lineComments).some((comment) => comment.severity === 'critical')
    : false;
  const hasCriticalIssues = Array.isArray(review.criticalIssues)
    ? filterCriticalIssuesByQuality(review.criticalIssues).length > 0
    : false;

  return hasCriticalLineComment || hasCriticalIssues;
}

/**
 * Recompute approved from blocking semantics without mutating the review.
 */
export function withBlockingApproval(review: ReviewResult): ReviewResult {
  return {
    ...review,
    approved: !hasBlockingFindings(review),
  };
}

/**
 * Deterministic post-LLM quality gate for inline comments.
 * Drops vague advisory/style/noise findings and requires critical comments to
 * describe a concrete failure mechanism or consequence.
 */
export function filterLineCommentsByQuality(
  comments: ReviewComment[],
  patternWeights?: Map<string, PatternWeight>
): ReviewComment[] {
  return comments
    .filter((comment) => shouldKeepLineComment(comment, patternWeights))
    .map((comment) => calibrateSeverity(comment, patternWeights));
}

export function shouldKeepLineComment(
  comment: ReviewComment,
  patternWeights?: Map<string, PatternWeight>
): boolean {
  const body = comment.body ?? '';
  const searchable = `${body}\n${comment.issueKey ?? ''}\n${comment.ruleId ?? ''}`;
  const hasCriticalDomain = CRITICAL_DOMAIN_PATTERN.test(searchable);
  const hasConcreteFailure = hasConcreteFailureDescription(searchable);

  if (STYLE_NOISE_PATTERNS.some((pattern) => pattern.test(searchable)) && !hasCriticalDomain) {
    return false;
  }

  if (isVagueAdvisory(searchable) && !hasConcreteFailure) {
    return false;
  }

  if (comment.severity === 'critical') {
    if (!hasConcreteFailure) return false;
  } else {
    if (!hasConcreteFailure || isVagueAdvisory(searchable)) return false;
  }

  // Check pattern confidence: drop low-confidence rules with sufficient sample size
  if (patternWeights && comment.ruleId) {
    const weight = patternWeights.get(comment.ruleId);
    if (weight && weight.confidence < 0.3 && weight.total_findings >= 10) {
      return false; // Low confidence pattern → drop
    }
  }

  return true;
}

/**
 * Calibrate comment severity based on pattern confidence.
 * Demotes critical to suggestion if the rule has low confidence with sufficient samples.
 */
function calibrateSeverity(
  comment: ReviewComment,
  patternWeights?: Map<string, PatternWeight>
): ReviewComment {
  if (!patternWeights || !comment.ruleId) {
    // Apply default labeling when no pattern weights
    return comment.severity === 'critical'
      ? labelCriticalComment(comment)
      : labelNonBlockingComment(comment);
  }

  const weight = patternWeights.get(comment.ruleId);
  if (!weight) {
    return comment.severity === 'critical'
      ? labelCriticalComment(comment)
      : labelNonBlockingComment(comment);
  }

  // If confidence is low and severity is critical, demote to suggestion
  if (weight.confidence < 0.4 && comment.severity === 'critical' && weight.total_findings >= 5) {
    const body = comment.body.replace(/🔴\s*\*\*Issue:\*\*/gi, '🟡 **Suggestion:**');
    return { ...comment, severity: 'suggestion', body };
  }

  return comment.severity === 'critical'
    ? labelCriticalComment(comment)
    : labelNonBlockingComment(comment);
}

export function filterCriticalIssuesByQuality(issues: string[]): string[] {
  return issues.filter((issue) => shouldKeepCriticalIssue(issue));
}

function shouldKeepCriticalIssue(issue: string): boolean {
  const text = issue ?? '';

  if (!text.trim()) {
    return false;
  }

  const hasCriticalDomain = CRITICAL_DOMAIN_PATTERN.test(text);
  const hasConcreteFailure = hasConcreteFailureDescription(text);

  if (STYLE_NOISE_PATTERNS.some((pattern) => pattern.test(text)) && !hasCriticalDomain) {
    return false;
  }

  if (isVagueAdvisory(text) && !hasConcreteFailure) {
    return false;
  }

  return hasConcreteFailure;
}

function isVagueAdvisory(text: string): boolean {
  if (!ADVISORY_WORD_PATTERN.test(text)) {
    return false;
  }

  return !hasConcreteFailureDescription(text);
}

function hasConcreteFailureDescription(text: string): boolean {
  return (
    CONCRETE_FAILURE_PATTERN.test(text) ||
    CONCRETE_FAILURE_STATE_PATTERN.test(text) ||
    (CRITICAL_DOMAIN_PATTERN.test(text) && CONCRETE_VULNERABILITY_MECHANISM_PATTERN.test(text))
  );
}

function labelNonBlockingComment(comment: ReviewComment): ReviewComment {
  const body = comment.body
    .replace(/🔴\s*\*\*Issue:\*\*/i, '🟡 **Suggestion:**')
    .replace(/🔴\s*\*\*Critical Issue:\*\*/i, '🟡 **Suggestion:**');

  return { ...comment, body };
}

function labelCriticalComment(comment: ReviewComment): ReviewComment {
  const body = comment.body.replace(/🟡\s*\*\*Suggestion:\*\*/i, '🔴 **Issue:**');
  return { ...comment, body };
}

/**
 * Normalize and validate the review result.
 * Derives issue keys, reconciles with previous comments, normalizes prSummary.
 */
export function normalizeReviewResult(
  result: ReviewResult,
  previousComments?: PreviousComment[],
  severityOverrides?: Record<string, 'critical' | 'suggestion' | 'low'>,
  patternWeights?: Map<string, PatternWeight>
): ReviewResult {
  const lineComments = Array.isArray(result.lineComments)
    ? result.lineComments.map((comment) => ({
        ...comment,
        issueKey: deriveIssueKey(comment),
        body: normalizeCommentBody(comment.body),
      }))
    : [];
  const reconciledLineComments = reconcileIssueKeys(lineComments, previousComments ?? []);

  // Apply severity overrides from .donmerge config
  const overriddenLineComments = severityOverrides
    ? reconciledLineComments.map((comment) => {
        const override = getSeverityOverride(comment.path, severityOverrides);
        if (override) {
          return { ...comment, severity: override };
        }
        return comment;
      })
    : reconciledLineComments;

  const finalLineComments = filterLineCommentsByQuality(overriddenLineComments, patternWeights);

  const criticalIssues = Array.isArray(result.criticalIssues)
    ? filterCriticalIssuesByQuality(result.criticalIssues)
    : [];

  const approved = !hasBlockingFindings({ lineComments: finalLineComments, criticalIssues });

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
