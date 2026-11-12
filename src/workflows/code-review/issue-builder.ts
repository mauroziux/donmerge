/**
 * Pure function to build CurrentIssue array from review line comments.
 *
 * Extracted from ReviewProcessor for reuse by the CodeReviewWorkflow.
 */

import type { ReviewComment, TrackedIssue } from './types';
import {
  buildAnchorKey,
  buildLogicalKey,
  computeFingerprint,
  computeSnippetHash,
  normalizeEntityType,
  normalizeRuleId,
  normalizeSymbolName,
} from './issue-identity';
import type { CurrentIssue } from './issue-matcher';

export interface IssueBuilderContext {
  repo: string;
  prNumber: number;
}

/**
 * Build CurrentIssue array from review line comments.
 */
export function hasCompleteReviewIdentity(comment: ReviewComment): boolean {
  return Boolean(normalizeRuleId(comment.ruleId) && normalizeEntityType(comment.entityType) && normalizeSymbolName(comment.symbolName) && comment.codeSnippet);
}

export function identityForReviewComment(comment: ReviewComment) {
  const ruleId = normalizeRuleId(comment.ruleId);
  const symbolName = normalizeSymbolName(comment.symbolName);
  const complete = hasCompleteReviewIdentity(comment);
  const occurrence = Array.from(
    new TextEncoder().encode(JSON.stringify([comment.path, comment.line, comment.side, comment.body])),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const sparseKey = complete ? '' : Array.from(
    new TextEncoder().encode(JSON.stringify([
      comment.path, comment.line, comment.side, comment.severity, comment.body,
      comment.ruleId ?? '', comment.entityType ?? '', comment.symbolName ?? '', comment.codeSnippet ?? '',
    ])),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  return {
    ruleId: ruleId ?? 'unspecified',
    entityType: normalizeEntityType(comment.entityType) ?? 'function',
    symbolName: complete ? symbolName! : `${symbolName ?? ''}|${sparseKey}`,
    filePath: comment.path,
    // Distinguish occurrences even when the model supplies identical semantic metadata.
    codeSnippet: complete ? `${comment.codeSnippet!} ${occurrence}` : sparseKey,
  };
}

export async function buildCurrentIssues(
  context: IssueBuilderContext,
  headSha: string,
  comments: ReviewComment[]
): Promise<CurrentIssue[]> {
  const now = new Date().toISOString();
  return Promise.all(
    comments.map(async (comment) => {
      const identityInput = identityForReviewComment(comment);
      const { ruleId, entityType, symbolName } = identityInput;
      const snippetHash = await computeSnippetHash(identityInput.codeSnippet);

      const fingerprint = await computeFingerprint(identityInput);
      const logicalKey = buildLogicalKey(identityInput);
      const anchorKey = buildAnchorKey(identityInput);

      const tracked: TrackedIssue = {
        id: `${fingerprint}`,
        fingerprint,
        logicalKey,
        anchorKey,
        repo: context.repo,
        prNumber: context.prNumber,
        ruleId,
        entityType: entityType as TrackedIssue['entityType'],
        symbolName,
        filePath: comment.path,
        line: comment.line,
        side: comment.side,
        snippetHash,
        severity: comment.severity,
        body: comment.body,
        status: 'new' as const,
        firstSeenCommit: headSha,
        lastSeenCommit: headSha,
        createdAt: now,
        updatedAt: now,
      };

      return { fingerprint, logicalKey, anchorKey, payload: tracked };
    })
  );
}
