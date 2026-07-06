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
export async function buildCurrentIssues(
  context: IssueBuilderContext,
  headSha: string,
  comments: ReviewComment[]
): Promise<CurrentIssue[]> {
  const now = new Date().toISOString();
  return Promise.all(
    comments.map(async (comment) => {
      const ruleId = normalizeRuleId(comment.ruleId) ?? 'unspecified';
      const entityType = normalizeEntityType(comment.entityType) ?? 'function';
      const symbolName = normalizeSymbolName(comment.symbolName) ?? '';
      const snippetHash = await computeSnippetHash(comment.codeSnippet ?? '');

      const identityInput = {
        ruleId,
        entityType,
        symbolName,
        filePath: comment.path,
        codeSnippet: comment.codeSnippet ?? '',
      };

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
