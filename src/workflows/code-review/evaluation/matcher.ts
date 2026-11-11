/**
 * Defect-identity matching for evaluation (plan 001-U2).
 *
 * A reported comment "detects" a known defect when it points at the same
 * defect — not when it uses the same words. Matching is deterministic:
 *
 *   1. same file, AND
 *   2. either an identity-token match (comment issueKey/ruleId vs defect id,
 *      kebab-token overlap) or line proximity (±10) plus a minimal term
 *      overlap between the comment body and the defect description.
 *
 * Each comment satisfies at most one defect (greedy, in corpus order) so a
 * duplicate report of the same bug counts once as detection and once as a
 * duplicate — precision is not inflated by re-stating the same finding.
 */

import type { KnownDefect } from './corpus';
import type { ReviewComment } from '../types';

const LINE_PROXIMITY = 10;
const TERM_OVERLAP_MIN = 2;

function kebabTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2)
  );
}

function termOverlap(a: string, b: string): number {
  const tokensA = kebabTokens(a);
  const tokensB = kebabTokens(b);
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  return overlap;
}

function identityTokens(comment: ReviewComment): Set<string> {
  return kebabTokens(`${comment.issueKey ?? ''} ${comment.ruleId ?? ''}`);
}

function sameFile(comment: ReviewComment, defect: KnownDefect): boolean {
  return comment.path === defect.file || comment.path.endsWith(`/${defect.file}`);
}

function identityMatch(comment: ReviewComment, defect: KnownDefect): boolean {
  const defectTokens = kebabTokens(defect.id);
  for (const token of identityTokens(comment)) {
    if (defectTokens.has(token)) return true;
  }
  return false;
}

function proximityMatch(comment: ReviewComment, defect: KnownDefect): boolean {
  if (defect.lineHint === undefined) return false;
  if (Math.abs(comment.line - defect.lineHint) > LINE_PROXIMITY) return false;
  return termOverlap(comment.body, defect.description) >= TERM_OVERLAP_MIN;
}

/** Whether this comment is a report of this known defect. */
export function commentMatchesDefect(comment: ReviewComment, defect: KnownDefect): boolean {
  if (!sameFile(comment, defect)) return false;
  return identityMatch(comment, defect) || proximityMatch(comment, defect);
}

export interface MatchResult {
  detected: KnownDefect[];
  missed: KnownDefect[];
  unmatchedComments: number;
  duplicates: number;
}

/**
 * Match pipeline comments against ground truth. Greedy in corpus order:
 * a comment already consumed by a defect cannot re-detect another.
 */
export function matchCommentsToDefects(
  comments: ReviewComment[],
  defects: KnownDefect[]
): MatchResult {
  const consumedDefects = new Set<string>();
  const consumedComments = new Set<number>();
  let duplicates = 0;

  for (const defect of defects) {
    for (let i = 0; i < comments.length; i += 1) {
      if (consumedComments.has(i)) continue;
      if (commentMatchesDefect(comments[i], defect)) {
        consumedComments.add(i);
        consumedDefects.add(defect.id);
        break; // first matching comment detects the defect
      }
    }
  }

  // Any additional comment that ALSO matches an already-detected defect is a
  // duplicate restatement, not a new detection.
  for (let i = 0; i < comments.length; i += 1) {
    if (consumedComments.has(i)) continue;
    const isDuplicate = defects.some(
      (defect) => consumedDefects.has(defect.id) && commentMatchesDefect(comments[i], defect)
    );
    if (isDuplicate) duplicates += 1;
  }

  return {
    detected: defects.filter((d) => consumedDefects.has(d.id)),
    missed: defects.filter((d) => !consumedDefects.has(d.id)),
    unmatchedComments: comments.length - consumedComments.size - duplicates,
    duplicates,
  };
}
