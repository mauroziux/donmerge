/**
 * GitHub API operations for the code review workflow.
 */

import type { PreviousComment, RepoContext, ReviewResult } from './types';
import { attachFingerprint, computeFingerprint, parseFingerprint } from './fingerprint';
import { normalizeEntityType, normalizeRuleId, normalizeSymbolName } from './issue-identity';
import { deriveIssueKey } from './issue-key';

const RESOLVED_REPLY_MARKER = '✅ **Fixed!**';
const META_MARKER_PREFIX = '<!-- DONMERGE_META:';

/**
 * Generic GitHub API fetch helper.
 */
export async function githubFetch<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codex-review-worker',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as T;
}

/**
 * Create a check run for the PR.
 */
export async function createCheckRun(
  owner: string,
  repo: string,
  headSha: string,
  token: string
): Promise<{ id: number }> {
  return githubFetch<{ id: number }>(
    `https://api.github.com/repos/${owner}/${repo}/check-runs`,
    token,
    'POST',
    {
      name: 'DonMerge 🤠 Review',
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    }
  );
}

/**
 * Complete a check run with the review result.
 */
export async function completeCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  review: ReviewResult,
  token: string
): Promise<void> {
  const title = review.approved ? '✅ All good, compadre!' : '⚠️ Ojo, some things need attention';
  const critical =
    review.criticalIssues.length > 0
      ? review.criticalIssues.map((issue) => `- ${issue}`).join('\n')
      : '- None, ¡nada que objetar!';
  const suggestions =
    review.suggestions.length > 0
      ? review.suggestions.map((issue) => `- ${issue}`).join('\n')
      : '- All clean!';

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion: review.approved ? 'success' : 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title,
        summary: review.summary,
        text: `🔴 Critical Issues:\n${critical}\n\n💡 Suggestions:\n${suggestions}`,
      },
    }
  );
}

/**
 * Fail a check run with an error message.
 */
export async function failCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  message: string,
  token: string
): Promise<void> {
  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title: '🤠 DonMerge hit a snag',
        summary: 'Something went wrong during the review. Check the logs.',
        text: message,
      },
    }
  );
}

/**
 * Add a reaction to a comment.
 */
export async function addCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  commentType: 'issue' | 'review',
  token: string
): Promise<void> {
  const url =
    commentType === 'issue'
      ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`
      : `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`;

  try {
    await githubFetch(url, token, 'POST', { content: 'eyes' });
  } catch (error) {
    console.error('Failed to add reaction', {
      owner,
      repo,
      commentId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Publish a review with line comments.
 */
export async function publishReview(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  review: ReviewResult,
  token: string,
  previousComments?: PreviousComment[]
): Promise<void> {
  const existingFingerprints = new Set<string>();
  if (previousComments && previousComments.length > 0) {
    for (const comment of previousComments) {
      if (comment.resolved) {
        continue;
      }
      if (comment.fingerprint) {
        existingFingerprints.add(comment.fingerprint);
        continue;
      }
      const fallback = await computeFingerprint({ path: comment.path, line: comment.line });
      existingFingerprints.add(fallback);
    }
  }

  const uniqueLineComments: Array<{
    path: string;
    body: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
  }> = [];

  for (const comment of review.lineComments) {
    const fingerprint = await computeFingerprint({
      path: comment.path,
      issueKey: comment.issueKey,
      line: comment.line,
      side: comment.side,
      severity: comment.severity,
    });

    if (existingFingerprints.has(fingerprint)) {
      continue;
    }

    existingFingerprints.add(fingerprint);
    const bodyWithMeta = attachCommentMeta(attachFingerprint(comment.body, fingerprint), {
      ruleId: comment.ruleId,
      entityType: comment.entityType,
      symbolName: comment.symbolName,
      codeSnippet: comment.codeSnippet,
    });

    uniqueLineComments.push({
      path: comment.path,
      body: bodyWithMeta,
      line: comment.line,
      side: comment.side,
    });
  }

  const comments = uniqueLineComments.slice(0, 40);

  const payload = {
    commit_id: headSha,
    body: review.summary,
    event: review.approved ? 'COMMENT' : 'REQUEST_CHANGES',
    comments,
  };

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    token,
    'POST',
    payload
  );
}

export async function fetchReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<Array<{ id: number; path: string; line: number; body: string }>> {
  const comments = await githubFetch<
    Array<{ id: number; path: string; line: number; body: string; user?: { login: string } }>
  >(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`, token);

  return comments.map((comment) => ({
    id: comment.id,
    path: comment.path,
    line: comment.line,
    body: comment.body,
  }));
}

/**
 * Update the PR description with the review summary.
 */
export async function updatePRDescription(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  token: string
): Promise<void> {
  const pr = await githubFetch<{ body: string; title: string }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token
  );

  const donmergeSection = buildDonmergeSection(review);
  const separator = '<!-- donmerge-review -->';

  let newBody = pr.body ?? '';

  // Remove existing donmerge section if present
  const separatorIndex = newBody.indexOf(separator);
  if (separatorIndex !== -1) {
    newBody = newBody.substring(0, separatorIndex).trimEnd();
  }

  // Append new donmerge section
  newBody = `${newBody}\n\n${separator}\n${donmergeSection}`;

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
    'PATCH',
    { body: newBody }
  );
}

/**
 * Build the DonMerge section for the PR description.
 */
function buildDonmergeSection(review: ReviewResult): string {
  const statusEmoji = review.approved ? '✅' : '⚠️';
  const statusText = review.approved ? 'All good, compadre!' : 'Ojo, some things need attention';
  const timestamp = new Date().toISOString();

  let section = `
## DonMerge 🤠 Code Review

**Status:** ${statusEmoji} ${statusText}
`;

  // Add structured summary if available
  if (review.prSummary) {
    const { overview, keyChanges, codeQuality, testingNotes, riskAssessment } = review.prSummary;

    section += `
### 📋 Overview
${overview}
`;

    if (keyChanges.length > 0) {
      section += `
### 🔧 Key Changes
${keyChanges.map((change) => `- ${change}`).join('\n')}
`;
    }

    section += `
### ✨ Code Quality
${codeQuality}

### 🧪 Testing Analysis
${testingNotes}

### ⚡ Risk Assessment
${riskAssessment}
`;
  } else {
    // Fallback to simple summary
    section += `\n${review.summary}\n`;
  }

  // Only add issue lists if there are issues
  if (review.criticalIssues.length > 0) {
    section += `\n### 🔴 Critical Issues\n${review.criticalIssues.map((i) => `- ${i}`).join('\n')}\n`;
  }

  if (review.suggestions.length > 0) {
    section += `\n### 💡 Suggestions\n${review.suggestions.map((s) => `- ${s}`).join('\n')}\n`;
  }

  section += `\n---\n*Reviewed by DonMerge 🤠 — ${timestamp}*\n`;

  return section;
}

/**
 * Fetch previous DonMerge review comments from the PR.
 */
export async function fetchPreviousDonMergeComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<PreviousComment[]> {
  try {
    // Fetch all review comments on the PR
    const comments = await githubFetch<
      Array<{
        id: number;
        path: string;
        line: number;
        body: string;
        user: { login: string } | null;
        in_reply_to_id?: number;
      }>
    >(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
      token
    );

    const donmergeComments = comments.filter(
      (c) =>
        c.user?.login &&
        (c.user.login.includes('donmerge') || c.user.login.includes('DonMerge'))
    );

    const resolutionReplies = new Map<number, number>();
    for (const comment of donmergeComments) {
      if (!comment.in_reply_to_id || !comment.body.includes(RESOLVED_REPLY_MARKER)) {
        continue;
      }
      resolutionReplies.set(comment.in_reply_to_id, comment.id);
    }

    const originalComments = donmergeComments.filter(
      (comment) => !comment.in_reply_to_id && !comment.body.includes(RESOLVED_REPLY_MARKER)
    );

    const mapped = await Promise.all(
      originalComments.map(async (comment) => {
        const metadata = parseFingerprint(comment.body);
        const fingerprint =
          metadata?.fingerprint ?? (await computeFingerprint({ path: comment.path, line: comment.line }));
        const resolutionReplyId = resolutionReplies.get(comment.id);
        const issueKey = deriveIssueKey({ body: comment.body });
        const meta = parseCommentMeta(comment.body);

        return {
          id: comment.id,
          path: comment.path,
          line: comment.line,
          body: comment.body,
          fingerprint,
          issueKey,
          ruleId: meta?.ruleId,
          entityType: meta?.entityType,
          symbolName: meta?.symbolName,
          codeSnippet: meta?.codeSnippet,
          resolved: resolutionReplyId !== undefined,
          resolutionReplyId,
        };
      })
    );

    return mapped;
  } catch (error) {
    console.error('Failed to fetch previous comments', {
      owner,
      repo,
      prNumber,
      error: error instanceof Error ? error.message : error,
    });
    return [];
  }
}

function attachCommentMeta(
  body: string,
  meta: {
    ruleId?: string;
    entityType?: string;
    symbolName?: string;
    codeSnippet?: string;
  }
): string {
  const payload = {
    ruleId: normalizeRuleId(meta.ruleId),
    entityType: normalizeEntityType(meta.entityType),
    symbolName: normalizeSymbolName(meta.symbolName),
    codeSnippet: meta.codeSnippet ?? undefined,
  };

  return `${META_MARKER_PREFIX} ${JSON.stringify(payload)} -->\n\n${body}`;
}

function parseCommentMeta(body: string): {
  ruleId?: string;
  entityType?: string;
  symbolName?: string;
  codeSnippet?: string;
} | null {
  const markerIndex = body.indexOf(META_MARKER_PREFIX);
  if (markerIndex === -1) {
    return null;
  }

  const endIndex = body.indexOf('-->', markerIndex);
  if (endIndex === -1) {
    return null;
  }

  const raw = body.substring(markerIndex + META_MARKER_PREFIX.length, endIndex).trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      ruleId?: string;
      entityType?: string;
      symbolName?: string;
      codeSnippet?: string;
    };
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reply to resolved comments acknowledging the fix.
 */
export async function resolveFixedComments(
  owner: string,
  repo: string,
  prNumber: number,
  comments: PreviousComment[],
  token: string
): Promise<void> {
  for (const comment of comments) {
    if (comment.resolved) {
      continue;
    }

    try {
      await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        token,
        'POST',
        {
          in_reply_to: comment.id,
          body: `${RESOLVED_REPLY_MARKER} Thanks for addressing this, compadre! 🤠`,
        }
      );
    } catch (error) {
      console.error('Failed to reply to resolved comment', {
        owner,
        repo,
        commentId: comment.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}

/**
 * Fetch a single file from the repository (returns null if not found)
 */
async function fetchRepoFile(
  owner: string,
  repo: string,
  path: string,
  token: string
): Promise<string | null> {
  try {
    const response = await githubFetch<{ content: string; encoding: string }>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      token
    );
    
    if (response.encoding === 'base64') {
      return atob(response.content);
    }
    return response.content;
  } catch (error) {
    // File doesn't exist or other error - return null
    return null;
  }
}

/**
 * Files to fetch for repo context, in priority order
 */
const REPO_CONTEXT_FILES: Array<{ path: string; key: keyof RepoContext }> = [
  // Standards/Instructions
  { path: 'AGENTS.md', key: 'agents' },
  { path: '.cursorrules', key: 'cursorrules' },
  { path: 'CLAUDE.md', key: 'claude' },
  { path: 'CONTRIBUTING.md', key: 'contributing' },
  { path: 'DEVELOPMENT.md', key: 'development' },
  
  // Config files
  { path: 'package.json', key: 'packageJson' },
  { path: 'tsconfig.json', key: 'tsconfig' },
  { path: 'eslint.config.js', key: 'eslint' },
  { path: '.eslintrc.js', key: 'eslint' },
  { path: '.eslintrc.json', key: 'eslint' },
  { path: '.eslintrc', key: 'eslint' },
  { path: '.prettierrc', key: 'prettier' },
  { path: '.prettierrc.json', key: 'prettier' },
  { path: 'biome.json', key: 'biome' },
  
  // Documentation
  { path: 'README.md', key: 'readme' },
];

/**
 * Fetch repository context files (standards, configs, docs) for better reviews.
 * Returns an object with the content of each file that exists.
 */
export async function fetchRepoContext(
  owner: string,
  repo: string,
  token: string
): Promise<RepoContext> {
  const context: RepoContext = {};
  
  // Fetch all files in parallel
  const fetchPromises = REPO_CONTEXT_FILES.map(async ({ path, key }) => {
    // Skip if we already have this key (e.g., eslint.config.js took precedence)
    if (context[key]) return;
    
    const content = await fetchRepoFile(owner, repo, path, token);
    if (content !== null) {
      context[key] = content;
    }
  });
  
  await Promise.all(fetchPromises);
  
  // Log what we found
  const found = Object.keys(context).filter(k => context[k as keyof RepoContext]);
  console.log('Fetched repo context files', { owner, repo, files: found });
  
  return context;
}
