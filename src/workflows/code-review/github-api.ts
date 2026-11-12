/**
 * GitHub API operations for the code review workflow.
 */

import type { PreviousComment, RepoContext, ReviewResult, FilePatch, DroppedComment } from './types';
import { ErrorCodeDescriptions, type ErrorCode } from './error-codes';
import { attachFingerprint, computeFingerprint, parseFingerprint } from './fingerprint';
import { normalizeEntityType, normalizeRuleId, normalizeSymbolName } from './issue-identity';
import { deriveIssueKey } from './issue-key';
import { filterCriticalIssuesByQuality, filterLineCommentsByQuality, hasBlockingFindings } from './processor-utils';
import {
  buildPrFilesPageUrl,
  shouldStopPaginating,
  GITHUB_PR_FILES_HARD_CAP,
  type PrFileEntry,
  type PrFilesDiscovery,
} from './review-snapshot';
import type { CoverageManifest } from './review-coverage';
import { checkConclusion, coverageReportText } from './review-coverage';
import { buildCommentableMap, validateInlineComments } from './comment-anchors';
import { GitHubApiError, withBoundedRetry, isTransientGitHubError, isTransportError, TRANSIENT_RETRY_DELAYS_MS } from './github-retry';
import { isDegenerateReviewBody, DEGENERATE_BODY_FALLBACK, reviewSkipDecision } from './review-body-guard';

const RESOLVED_REPLY_MARKER = '✅ **Fixed!**';
const META_MARKER_PREFIX = '<!-- DONMERGE_META:';
const REVIEW_META_PREFIX = '<!-- DONMERGE_REVIEW:';

/**
 * Build a per-review metadata HTML comment pinning the reviewed commit and base ref.
 * Invisible in rendered markdown but machine-parseable, so a reader can tell whether
 * findings are stale after a push. Distinct from the per-comment DONMERGE marker.
 * `runId` makes the publication idempotent: a step replay can detect its own
 * earlier POST and reconcile instead of duplicating the review (plan 004-U4).
 */
function buildReviewMeta(input: { headSha: string; baseRef?: string; runId?: string }): string {
  const payload = {
    headSha: input.headSha,
    baseRef: input.baseRef,
    runId: input.runId,
    reviewedAt: new Date().toISOString(),
  };
  return `${REVIEW_META_PREFIX} ${JSON.stringify(payload)} -->\n\n`;
}

/** Parsed DONMERGE_REVIEW marker from a review body. */
export interface ReviewMarker {
  headSha: string;
  baseRef?: string;
  /** Present on reviews published after run fencing landed (plan 004). */
  runId?: string;
  reviewedAt?: string;
}

/** Extract the DONMERGE_REVIEW marker from a review body, or null. */
export function parseReviewMarker(body: string): ReviewMarker | null {
  const start = body.indexOf(REVIEW_META_PREFIX);
  if (start === -1) return null;
  const jsonStart = start + REVIEW_META_PREFIX.length;
  const end = body.indexOf('-->', jsonStart);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(body.slice(jsonStart, end).trim());
    if (typeof parsed?.headSha === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export const SUPERSEDED_NOTE_PREFIX = '⚠️ **OUTDATED — superseded:**';

/**
 * Insert a superseded note after the marker comment. Idempotent: a body that
 * already carries the note is returned untouched.
 */
export function buildSupersededBody(body: string, oldBaseRef: string, newBaseRef: string): string {
  if (body.includes(SUPERSEDED_NOTE_PREFIX)) return body;
  const note =
    `> ${SUPERSEDED_NOTE_PREFIX} this review ran against the old base \`${oldBaseRef}\`. ` +
    `A newer review below covers the current base \`${newBaseRef}\`.`;
  const markerEnd = body.indexOf('-->');
  if (markerEnd === -1) return `${note}\n\n${body}`;
  return `${body.slice(0, markerEnd + 3)}\n\n${note}${body.slice(markerEnd + 3)}`;
}

/**
 * Edit previous bot reviews whose marker baseRef differs from the current base,
 * marking them as superseded. Best-effort: failures never block the new review.
 */
export async function supersedeBaseChangedReviews(
  owner: string,
  repo: string,
  prNumber: number,
  currentBaseRef: string | undefined,
  token: string
): Promise<number> {
  if (!currentBaseRef) return 0;
  try {
    const reviews = await githubFetch<
      Array<{ id: number; body?: string; user?: { type?: string } }>
    >(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`, token);

    let superseded = 0;
    for (const review of reviews) {
      if (review.user?.type !== 'Bot' || !review.body) continue;
      const marker = parseReviewMarker(review.body);
      if (!marker?.baseRef || marker.baseRef === currentBaseRef) continue;
      await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${review.id}`,
        token,
        'PUT',
        { body: buildSupersededBody(review.body, marker.baseRef, currentBaseRef) }
      );
      superseded += 1;
    }
    return superseded;
  } catch (error) {
    console.warn('Failed to supersede outdated reviews', { owner, repo, prNumber, error });
    return 0;
  }
}

/**
 * Find PR refs (#N) of commits in a divergent ahead-range that were already
 * merged elsewhere — squash-merge subjects (`(#N)`) or merge commits
 * (`Merge pull request #N from ...`). The PR's own number is excluded.
 */
export function findInheritedCommitRefs(commitSubjects: string[], prNumber: number): string[] {
  const refs = new Set<string>();
  for (const subject of commitSubjects) {
    const squash = subject.match(/\s\(#(\d+)\)\s*$/);
    const merge = subject.match(/^Merge pull request #(\d+) from /);
    const match = squash ?? merge;
    if (match && Number(match[1]) !== prNumber) {
      refs.add(`#${match[1]}`);
    }
  }
  return Array.from(refs);
}

/**
 * Detect a contaminated three-dot diff: head contains commits that were already
 * merged via other PRs (typical when a fix branch based on master targets develop).
 * Fail-open: on API errors returns [] so the review proceeds as before.
 */
export async function fetchInheritedCommitRefs(
  owner: string,
  repo: string,
  baseRef: string,
  headSha: string,
  prNumber: number,
  token: string
): Promise<string[]> {
  try {
    const compare = await githubFetch<{
      status?: string;
      commits?: Array<{ commit?: { message?: string } }>;
    }>(`https://api.github.com/repos/${owner}/${repo}/compare/${baseRef}...${headSha}`, token);
    if (compare.status !== 'diverged') return [];
    const subjects = (compare.commits ?? []).map((entry) =>
      (entry.commit?.message ?? '').split('\n')[0]
    );
    return findInheritedCommitRefs(subjects, prNumber);
  } catch (error) {
    console.warn('Divergence check failed, proceeding with review', { owner, repo, prNumber, error });
    return [];
  }
}

/**
 * Generic GitHub API fetch helper.
 */
export async function githubFetch<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
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
    throw new GitHubApiError(response.status, errorBody);
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
 * Complete check run with the review result.
 *
 * The conclusion is honest about scope (plan 002-U4): a run that could not
 * review the whole PR (budget/focus/API cap) reports `neutral`, never a green
 * success, unless blocking findings make it a failure regardless.
 */
export async function completeCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  review: ReviewResult,
  token: string,
  droppedComments: DroppedComment[] = [],
  coverage?: CoverageManifest
): Promise<void> {
  const approved = !hasBlockingFindings(review);
  const conclusion = checkConclusion(!approved, coverage, review.verificationPending);
  const title = !approved
    ? '⚠️ Ojo, some things need attention'
    : conclusion === 'success'
      ? '✅ All good, compadre!'
      : review.verificationPending
        ? '🟡 No blocking findings verified — unverified finding(s) pending'
        : '🟡 Partial review — no blocking issues in the reviewed scope';
  const criticalFindings = collectCriticalFindings(review);
  const critical =
    criticalFindings.length > 0
      ? criticalFindings.map((issue) => `- ${issue}`).join('\n')
      : '- None, ¡nada que objetar!';
  const suggestions =
    review.suggestions.length > 0
      ? review.suggestions.map((issue) => `- ${issue}`).join('\n')
      : '- All clean!';

  const droppedNote = formatDroppedCommentsNote(droppedComments);
  const coverageNote = coverage ? `\n\n${coverageReportText(coverage)}` : '';
  const text = `🔴 Critical Issues:\n${critical}\n\n💡 Suggestions:\n${suggestions}${droppedNote}${coverageNote}`;
  // When comments were dropped, flag it in the title so it is visible at a glance.
  const finalTitle = droppedComments.length > 0 ? `${title} · ${droppedComments.length} comment(s) dropped` : title;

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: finalTitle,
        summary: review.summary,
        text,
      },
    }
  );
}

/**
 * Fail a check run with an error code.
 * The full detail is logged to console; only the code appears in the public check run.
 */
export async function failCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  code: ErrorCode,
  detail: string,
  token: string
): Promise<void> {
  console.error(`[${code}] ${detail}`);

  const description =
    ErrorCodeDescriptions[code] ?? 'Check worker logs for details.';

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title: `🤠 DonMerge hit a snag [${code}]`,
        summary: 'Something went wrong during the review.',
        text: `Error code: ${code} — ${description}`,
      },
    }
  );
}

/**
 * Complete a check run with a neutral conclusion and custom output.
 * Used when the review is intentionally not run (e.g. contaminated diff).
 */
export async function completeCheckRunNeutral(
  owner: string,
  repo: string,
  checkRunId: number,
  title: string,
  summary: string,
  text: string,
  token: string
): Promise<void> {
  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion: 'neutral',
      completed_at: new Date().toISOString(),
      output: { title, summary, text },
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
  token: string,
  content: 'eyes' | 'thumbsup' | 'thumbsdown' | 'heart' | 'tada' = 'eyes'
): Promise<void> {
  const url =
    commentType === 'issue'
      ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`
      : `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`;

  try {
    await githubFetch(url, token, 'POST', { content });
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
 * Reply to an existing comment so the acknowledgment lands in the same thread.
 *
 * - Review comments (inline threads): POST /pulls/{pr}/comments/{commentId}/replies
 * - Issue comments (PR conversation): posts a regular issue comment (flat —
 *   GitHub has no reply endpoint there), so callers should use it sparingly.
 *
 * Returns the created comment id, or null when the reply could not be posted
 * (the error is logged, never thrown — acknowledgments are best-effort).
 */
export async function postReplyComment(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  commentType: 'issue' | 'review',
  body: string,
  token: string
): Promise<number | null> {
  const url =
    commentType === 'review'
      ? `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`
      : `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  try {
    const created = await githubFetch<{ id: number }>(url, token, 'POST', { body });
    return created.id;
  } catch (error) {
    console.error('Failed to post reply comment', {
      owner,
      repo,
      prNumber,
      commentId,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

/**
 * Fetch a single comment by ID (for extracting fingerprint from reacted comment).
 * Reactions can occur on both PR review comments (inline) and issue comments (conversation),
 * so we try the appropriate endpoint first and fall back to the other.
 */
export async function fetchCommentById(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
  commentType?: 'review' | 'issue'
): Promise<{ body: string; id: number; in_reply_to_id: number | null; path?: string; user?: { login?: string; type?: string } } | null> {
  try {
    const endpoint = commentType === 'issue'
      ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`
      : `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}`;

    const comment = await githubFetch<{ body: string; id: number; in_reply_to_id: number | null; path?: string; user?: { login?: string; type?: string } }>(
      endpoint,
      token
    );
    return comment;
  } catch {
    // If the primary endpoint fails, try the other one
    try {
      const fallbackEndpoint = commentType === 'issue'
        ? `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}`
        : `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;

      const comment = await githubFetch<{ body: string; id: number; in_reply_to_id: number | null; path?: string; user?: { login?: string; type?: string } }>(
        fallbackEndpoint,
        token
      );
      return comment;
    } catch {
      return null;
    }
  }
}

/**
 * Publish a review with line comments.
 *
 * Pre-validates inline comment anchors against the PR file patches (when provided)
 * so a single comment targeting a line outside a diff hunk cannot sink the whole
 * review with a 422. Returns the list of dropped comments so the caller can
 * surface them in the check-run summary.
 */
export async function publishReview(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  review: ReviewResult,
  token: string,
  previousComments?: PreviousComment[],
  filePatches?: FilePatch[],
  baseRef?: string,
  runId?: string,
  pollOptions: { tries?: number; delayMs?: number } = {},
  reservePublication?: () => Promise<boolean>
): Promise<DroppedComment[]> {
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

  // Pre-validate anchors before dedup: drop comments whose line is not inside a
  // diff hunk so GitHub never 422s the whole review over one bad anchor.
  let droppedComments: DroppedComment[] = [];
  let candidateComments = review.lineComments;
  if (filePatches && filePatches.length > 0) {
    const commentableMap = buildCommentableMap(filePatches);
    const validation = validateInlineComments(review.lineComments, commentableMap);
    candidateComments = validation.valid;
    droppedComments = validation.dropped;
    if (droppedComments.length > 0) {
      console.log(
        `Dropping ${droppedComments.length}/${review.lineComments.length} inline comment(s) that do not anchor to PR diff lines`
      );
    }
  }

  const uniqueLineComments: Array<{
    path: string;
    body: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
  }> = [];

  for (const comment of candidateComments) {
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

  // Skip decision FIRST (on original intent): if there is nothing to post and
  // it would 422 (empty non-approve COMMENT), skip the POST entirely. An empty
  // APPROVE is legitimate and is NOT skipped.
  const skip = reviewSkipDecision({
    approved: review.approved,
    body: review.summary,
    hasComments: comments.length > 0,
  });
  if (skip) {
    console.log(`Skipping review submission: ${skip.reason}`);
    return droppedComments;
  }

  // THEN guard the body for reviews that will actually post: never publish a
  // degenerate/placeholder summary verbatim. Substitute a safe fallback so the
  // review still posts (with any valid comments) but never with placeholder text.
  let body = review.summary;
  if (isDegenerateReviewBody(body)) {
    console.warn('Review summary is degenerate, substituting fallback', {
      originalLength: body.length,
    });
    body = DEGENERATE_BODY_FALLBACK;
  }

  // Idempotent publication (plan 004-U4): a durable step replay (or a retry
  // after an ambiguous transport failure) must not post the same run's review
  // twice. If a review carrying THIS run's marker already exists, reconcile
  // by skipping the POST. `unknown` (past the scan safety ceiling) REFUSES
  // the POST: on a replay that may be our own earlier publication, and a
  // blind POST could duplicate it. The step retry re-searches later; a
  // genuinely unpublished review is delayed, never lost.
  if (runId) {
    const lookup = await findPublishedReviewForRun(owner, repo, prNumber, runId, headSha, token);
    if (lookup === 'found') {
      console.log('Publication already recorded for this run — skipping duplicate POST', {
        owner,
        repo,
        prNumber,
        runId,
      });
      return droppedComments;
    }
    if (lookup === 'unknown') {
      throw new Error(
        `publication state unknown for run ${runId} (marker scan ceiling) — refusing POST to avoid duplication`
      );
    }
  }

  const payload = {
    commit_id: headSha,
    body: buildReviewMeta({ headSha, baseRef, runId }) + body,
    event: review.approved ? 'COMMENT' : 'REQUEST_CHANGES',
    comments,
  };

  // Base changed since a previous review (retarget): mark the old review(s)
  // as superseded so readers do not mistake them for the current verdict.
  const supersededCount = await supersedeBaseChangedReviews(owner, repo, prNumber, baseRef, token);
  if (supersededCount > 0) {
    console.log('Superseded outdated review(s) with a different base', { supersededCount });
  }

  // Persist intent before any POST. On replay an invisible marker is not proof
  // of failure: an existing reservation prohibits another POST for this run.
  if (reservePublication && !(await reservePublication())) {
    throw new Error(`publication unresolved for run ${runId} — manual verification required, automated re-POST disabled`);
  }

  // Wrap the POST in a bounded retry for GitHub's transient "internal error" 422.
  // bail predicate scopes retries to the transient body only — real validation 422s
  // (anchor / body-length / suggestion) fail fast so they surface, not loop.
  // Ambiguous transport failures reconcile against the publication marker before
  // re-sending: an accepted-but-lost POST is detected, never duplicated (004-U4).
  // Idempotency-safe: githubFetch throws on non-2xx before returning, so a
  // successful post is never retried.
  await withBoundedRetry(
    async () => {
      try {
        return await githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
          token,
          'POST',
          payload
        );
      } catch (error) {
        // Any failure on the POST may be an accepted-but-lost request (transient
        // 422, dropped connection, transport rejection). Poll for the marker:
        //   found      → reconcile (never a second POST)
        //   not-found / poll error → the publication state is UNRESOLVED —
        //                a temporary absence does not prove the POST failed,
        //                so this call NEVER posts again: fail the step and let
        //                the durable retry re-search with fresh eyes.
        //   unknown    → page-capped scan → same refusal.
        if (runId) {
          let lookup: PublicationLookup;
          try {
            lookup = await waitForPublishedReviewForRun(
              owner,
              repo,
              prNumber,
              runId,
              headSha,
              token,
              pollOptions
            );
          } catch {
            lookup = 'unknown';
          }
          if (lookup === 'found') {
            console.log('Ambiguous publication failure reconciled — review already posted', {
              owner,
              repo,
              prNumber,
              runId,
            });
            return { reconciled: true };
          }
          throw new Error(
            `publication unresolved for run ${runId} after ambiguous failure — manual verification required, automated re-POST disabled`
          );
        }
        throw error;
      }
    },
    {
      delays: TRANSIENT_RETRY_DELAYS_MS,
      bail: (err) =>
        !(
          isTransientGitHubError(err) ||
          (isTransportError(err) &&
            !/publication unresolved|refusing POST|refusing blind retry/.test(
              err instanceof Error ? err.message : String(err)
            ))
        ),
      name: 'publishReview',
    }
  );

  return droppedComments;
}

export interface FetchedReviewComment {
  id: number;
  path: string;
  line: number;
  body: string;
  userLogin?: string;
  userType?: string;
}

/**
 * Fetch all review comments. GitHub paginates this endpoint at 30 by default;
 * use 100/page and continue until the final partial page so ID correlation
 * still works on busy PRs.
 */
export async function fetchReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<FetchedReviewComment[]> {
  const all: FetchedReviewComment[] = [];
  let page = 1;

  while (true) {
    const comments = await githubFetch<
      Array<{ id: number; path: string; line: number; body: string; user?: { login: string; type?: string } }>
    >(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`, token);

    all.push(...comments.map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      body: comment.body,
      userLogin: comment.user?.login,
      userType: comment.user?.type,
    })));

    if (comments.length < 100) return all;
    page += 1;
  }
}

/** Verify the one GitHub App account that owns DonMerge review comments. */
export function isDonmergeBotAuthor(user: { login?: string; type?: string } | null | undefined): boolean {
  return user?.type === 'Bot' && user.login?.toLowerCase() === 'donmerge[bot]';
}

/** Find a matching DonMerge-authored inline comment, not a copied user marker. */
export function findDonmergeReviewComment(
  comments: FetchedReviewComment[],
  path: string,
  fingerprint: string
): FetchedReviewComment | undefined {
  return comments.find((comment) => {
    const metadata = parseFingerprint(comment.body);
    return comment.path === path &&
      metadata?.fingerprint === fingerprint &&
      isDonmergeBotAuthor({ login: comment.userLogin, type: comment.userType });
  });
}

/**
 * Discover every file in the PR (all pages) for a versioned snapshot.
 *
 * Paginates the files listing until a short page, the PR's declared
 * `changed_files` count, or GitHub's 3000-file hard cap. The caller must
 * re-check the PR head afterwards (fetchPrHeadSha) — this endpoint describes
 * a mutable PR, so a push mid-pagination can mix versions.
 */
export async function fetchAllPrFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  declaredCount: number
): Promise<PrFilesDiscovery> {
  const files: PrFileEntry[] = [];
  let page = 1;
  let apiFileCapReached = false;

  for (;;) {
    const batch = await githubFetch<Array<{ filename: string; patch?: string }>>(
      buildPrFilesPageUrl(owner, repo, prNumber, page),
      token
    );
    files.push(...batch);

    if (
      shouldStopPaginating({
        fetchedThisPage: batch.length,
        totalFetched: files.length,
        declaredCount,
        page,
      })
    ) {
      apiFileCapReached = files.length >= GITHUB_PR_FILES_HARD_CAP;
      break;
    }

    page += 1;
  }

  return { files, apiFileCapReached, pagesFetched: page };
}

export type PublicationLookup = 'found' | 'not-found' | 'unknown';

/** Safety ceiling for the marker scan. Beyond it the PR has an absurd
 * number of reviews and `unknown` semantics apply (never a blind POST). */
const MARKER_SCAN_MAX_PAGES = 200; // 20,000 reviews

/**
 * Find a review already published by THIS run (same runId + headSha) by
 * scanning the PR's reviews for our machine marker — to the END of the list,
 * so a replay of an already-published run cannot POST again just because the
 * marker sits deep in the history. `unknown` is only possible past the
 * safety ceiling; callers must refuse a blind POST on it.
 */
export async function findPublishedReviewForRun(
  owner: string,
  repo: string,
  prNumber: number,
  runId: string,
  headSha: string,
  token: string
): Promise<PublicationLookup> {
  for (let page = 1; page <= MARKER_SCAN_MAX_PAGES; page += 1) {
    const reviews = await githubFetch<Array<{ body?: string }>>(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
      token
    );
    for (const review of reviews) {
      const marker = review.body ? parseReviewMarker(review.body) : null;
      if (marker?.runId === runId && marker.headSha === headSha) {
        return 'found';
      }
    }
    if (reviews.length < 100) return 'not-found';
  }
  return 'unknown';
}

/**
 * Poll briefly for the publication marker after an ambiguous POST failure:
 * GitHub's review listing can lag the write. Finds → reconciled. Still
 * absent after the poll → 'not-found'; page-capped → 'unknown'.
 */
export async function waitForPublishedReviewForRun(
  owner: string,
  repo: string,
  prNumber: number,
  runId: string,
  headSha: string,
  token: string,
  options: { tries?: number; delayMs?: number } = {}
): Promise<PublicationLookup> {
  // Wide window: GitHub's review listing can lag the write. The poll must
  // comfortably outlast that lag before we declare the state unresolved,
  // because the unresolved path refuses a second POST for the whole step.
  const tries = options.tries ?? 5;
  const delayMs = options.delayMs ?? 5_000;
  let last: PublicationLookup = 'not-found';
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await findPublishedReviewForRun(owner, repo, prNumber, runId, headSha, token);
    if (last !== 'not-found') return last;
    if (attempt < tries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return last;
}

/**
 * Fetch full file contents at an explicit ref for prompt context (plan 003-U1).
 * Host-side retrieval: the model receives code as DATA, never as a tool it
 * can point elsewhere. Budgeted — stops at the file/char caps.
 */
export async function fetchFileContentsAtRef(
  owner: string,
  repo: string,
  paths: string[],
  ref: string,
  token: string,
  limits: { maxFiles: number; maxCharsPerFile: number; maxCharsTotal: number }
): Promise<Array<{ path: string; content: string }>> {
  const candidates = paths.slice(0, limits.maxFiles);
  const results = await Promise.all(
    candidates.map(async (path) => ({
      path,
      content: await fetchRepoFile(owner, repo, path, token, ref),
    }))
  );

  const collected: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const { path, content } of results) {
    if (content === null || content === undefined) continue;
    const capped = content.slice(0, limits.maxCharsPerFile);
    if (total + capped.length > limits.maxCharsTotal) continue;
    collected.push({ path, content: capped });
    total += capped.length;
  }
  return collected;
}

/**
 * Current PR head SHA — used to detect that the PR moved while a snapshot
 * was being built (or right before publishing).
 */
export async function fetchPrHeadSha(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<string> {
  const pr = await githubFetch<{ head: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token
  );
  return pr.head.sha;
}

/**
 * Update the PR description with the review summary.
 */
export async function updatePRDescription(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  token: string,
  coverage?: CoverageManifest
): Promise<void> {
  const pr = await githubFetch<{ body: string; title: string }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token
  );

  const separator = '<!-- donmerge-review -->';

  let newBody = pr.body ?? '';

  // Remove existing donmerge section if present
  const separatorIndex = newBody.indexOf(separator);
  if (separatorIndex !== -1) {
    newBody = newBody.substring(0, separatorIndex).trimEnd();
  }

  // Append new donmerge section
  newBody = `${newBody}\n\n${separator}\n${buildDonmergeSection(review, coverage)}`;

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
function buildDonmergeSection(review: ReviewResult, coverage?: CoverageManifest): string {
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
  const criticalFindings = collectCriticalFindings(review);
  if (criticalFindings.length > 0) {
    section += `\n### 🔴 Critical Issues\n${criticalFindings.map((i) => `- ${i}`).join('\n')}\n`;
  }

  if (review.suggestions.length > 0) {
    section += `\n### 💡 Suggestions\n${review.suggestions.map((s) => `- ${s}`).join('\n')}\n`;
  }

  if (coverage && !coverage.scopeComplete) {
    section += `\n### 📊 Coverage\n${coverageReportText(coverage)}\n`;
  }

  if (review.verificationPending) {
    section += `\n### 🔍 Verification\nSome critical finding(s) could not be verified with the available evidence. This review does not certify the PR as clean; re-trigger to re-establish them.\n`;
  }

  section += `\n---\n*Reviewed by DonMerge 🤠 — ${timestamp}*\n`;

  return section;
}

function collectCriticalFindings(review: ReviewResult): string[] {
  const criticalIssues = filterCriticalIssuesByQuality(review.criticalIssues);
  if (criticalIssues.length > 0) {
    return criticalIssues;
  }

  return filterLineCommentsByQuality(review.lineComments)
    .filter((comment) => comment.severity === 'critical')
    .map((comment) => summarizeCommentBody(comment.body));
}

function summarizeCommentBody(body: string): string {
  const issueMatch = body.match(/(?:🔴\s*)?\*\*(?:Critical\s+)?Issue:\*\*\s*([^\n]+)/i);
  return issueMatch?.[1]?.trim() || body.split('\n')[0]?.trim() || 'Critical inline finding';
}

/** Cap the dropped-comment list so a pathological run doesn't blow past GitHub's ~65KB body limit. */
const MAX_DROPPED_COMMENT_LINES = 10;

/**
 * Format dropped comments into a markdown note for the check-run text.
 * Returns an empty string when there is nothing to report.
 */
export function formatDroppedCommentsNote(dropped: DroppedComment[]): string {
  if (dropped.length === 0) return '';
  const renderEntry = (d: DroppedComment): string => {
    return `- \`${d.path}:${d.line}\` (${d.side}) — ${d.reason}`;
  };
  const shown = dropped.slice(0, MAX_DROPPED_COMMENT_LINES).map(renderEntry);
  const remainder = dropped.length - shown.length;
  if (remainder > 0) shown.push(`- …and ${remainder} more dropped comment(s) not shown`);
  return (
    `\n\n---\n\n` +
    `**Note:** ${dropped.length} inline comment(s) dropped because they did not anchor to lines inside the PR diff:\n` +
    shown.join('\n')
  );
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
    // Fetch every page: old DonMerge findings may be beyond GitHub's default page.
    const comments: Array<{
      id: number;
      path: string;
      line: number;
      body: string;
      user: { login: string; type?: string } | null;
      in_reply_to_id?: number;
    }> = [];
    let page = 1;
    while (true) {
      const batch = await githubFetch<typeof comments>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
        token
      );
      comments.push(...batch);
      if (batch.length < 100) break;
      page += 1;
    }

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
          entityType: meta?.entityType as PreviousComment['entityType'],
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
  token: string,
  reserveReply: (commentId: number) => Promise<boolean>
): Promise<void> {
  for (const comment of comments) {
    if (comment.resolved) {
      continue;
    }

    // Reserve before the non-idempotent POST. An ambiguous response must
    // never cause another POST, even if this sacrifices an optional reply.
    if (!(await reserveReply(comment.id))) continue;
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
export async function fetchRepoFile(
  owner: string,
  repo: string,
  path: string,
  token: string,
  ref?: string
): Promise<string | null> {
  try {
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const response = await githubFetch<{ content: string; encoding: string }>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}${refQuery}`,
      token
    );
    
    if (response.encoding === 'base64') {
      const binary = atob(response.content);
      return new TextDecoder().decode(
        Uint8Array.from(binary, c => c.charCodeAt(0))
      );
    }
    return response.content;
  } catch (error) {
    // File doesn't exist or other error - return null
    return null;
  }
}

/**
 * Files to fetch for repo context. `priority` breaks ties within a key:
 * when several paths map to the same key (e.g. ESLint variants), the
 * lowest-priority-number existing file wins — deterministically, instead of
 * whichever parallel fetch happened to resolve last (plan 005-U1).
 */
const REPO_CONTEXT_FILES: Array<{ path: string; key: keyof RepoContext; priority: number }> = [
  // Standards/Instructions
  { path: 'AGENTS.md', key: 'agents', priority: 1 },
  { path: '.cursorrules', key: 'cursorrules', priority: 1 },
  { path: 'CLAUDE.md', key: 'claude', priority: 1 },
  { path: 'CONTRIBUTING.md', key: 'contributing', priority: 1 },
  { path: 'DEVELOPMENT.md', key: 'development', priority: 1 },

  // Config files (priority = preference order within the key)
  { path: 'package.json', key: 'packageJson', priority: 1 },
  { path: 'tsconfig.json', key: 'tsconfig', priority: 1 },
  { path: 'eslint.config.js', key: 'eslint', priority: 1 },
  { path: '.eslintrc.js', key: 'eslint', priority: 2 },
  { path: '.eslintrc.json', key: 'eslint', priority: 3 },
  { path: '.eslintrc', key: 'eslint', priority: 4 },
  { path: '.prettierrc', key: 'prettier', priority: 1 },
  { path: '.prettierrc.json', key: 'prettier', priority: 2 },
  { path: 'biome.json', key: 'biome', priority: 1 },

  // Documentation
  { path: 'README.md', key: 'readme', priority: 1 },
];

/**
 * Fetch repository context files (standards, configs, docs) for better reviews.
 * Reads at an explicit ref (the reviewed head) so the context matches the code
 * being reviewed instead of whatever the default branch points at.
 */
export async function fetchRepoContext(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<RepoContext> {
  const context: RepoContext = {};

  // Fetch all candidates in parallel, then select per key by declared priority.
  const results = await Promise.all(
    REPO_CONTEXT_FILES.map(async ({ path }) => ({
      path,
      content: await fetchRepoFile(owner, repo, path, token, ref),
    }))
  );

  const contentByPath = new Map(results.map(({ path, content }) => [path, content]));
  const selectedPriority = new Map<keyof RepoContext, number>();
  for (const { path, key, priority } of REPO_CONTEXT_FILES) {
    const content = contentByPath.get(path);
    if (content === null || content === undefined) continue;
    const existingPriority = selectedPriority.get(key);
    if (existingPriority === undefined || priority < existingPriority) {
      selectedPriority.set(key, priority);
      context[key] = content;
    }
  }

  // Log what we found
  const found = Object.keys(context).filter(k => context[k as keyof RepoContext]);
  console.log('Fetched repo context files', { owner, repo, ref, files: found });

  return context;
}
