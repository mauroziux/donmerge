/**
 * CodeReviewWorkflow — Cloudflare Workflow for running code reviews.
 *
 * Replaces the alarm-based execution in ReviewProcessor DO.
 * The DO handles status queries and concurrency; this Workflow handles the
 * long-running pipeline steps with durable retries and timeouts.
 *
 * Pipeline: fetch-pr-data → prepare-files → run-llm-review → publish-review
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';

import type {
  WorkerEnv,
  ReviewResult,
  PreviousComment,
  RepoContext as RepoContextType,
  TrackedIssue,
  DonmergeConfig,
  DonmergeResolved,
  MemoryContext,
  PatternWeight,
  FilePatch,
} from './types';
import {
  githubFetch,
  createCheckRun,
  failCheckRun,
  addCommentReaction,
  fetchPreviousDonMergeComments,
  fetchReviewComments,
  fetchRepoContext,
  fetchPolicyFile,
  fetchAllPrFiles,
  fetchFileContentsAtRef,
  publishReview,
  completeCheckRun,
  completeCheckRunNeutral,
  formatMissingPolicyFiles,
  fetchInheritedCommitRefs,
  fetchPrFilesBetween,
  supersedeBaseChangedReviews,
  updatePRDescription,
} from './github-api';
import { resolveGitHubToken } from './github-auth';
import { buildCurrentIssues, type IssueBuilderContext } from './issue-builder';
import { matchCurrentFindingsToStored } from './issue-matcher';
import { transitionToNew, transitionToOpen, transitionToReintroduced } from './issue-lifecycle';
import { applyApprovalGate } from './approval-gate';
import { parseModelConfig, getRepoConfig, classifyError } from './utils';
import { buildReviewPrompt } from './prompts';
import {
  buildOpencodeConfig,
  resolveFallbackModel,
  aiGatewayEnabled,
  buildAiGatewayOpencodeConfig,
  aiGatewayModelId,
  resolveReviewModels,
  AI_GATEWAY_PROVIDER_ID,
  type ModelConfig,
} from '../../lib/llm-providers';
import {
  fetchDonmergeConfig,
  shouldExcludeFile,
  resolveDonmergeSkills,
} from './donmerge';
import {
  filterCommentsByMatch,
  withBlockingApproval,
  hasBlockingFindings,
} from './processor-utils';
import { recordReviewFindings } from './feedback-handler';
import { buildReviewOutcomeInputs, newlyPublishedComments } from './review-outcomes';
import { buildMemoryContext, getPatternWeights, isMissingMemorySchema } from './memory-store';
import { scopedMemoryEnabledForRepo } from './memory-rollout';
import { citedLearningIds } from './memory-citations';
import { destroySandbox, SANDBOX_SLEEP_AFTER } from '../../lib/sandbox-lifecycle';
import { AllModelsFailedError, runReviewModels, DEFAULT_REVIEW_TOTAL_BUDGET_MS } from './review-model-runner';
import { PrHeadChangedError } from './review-snapshot';
import { ErrorCode } from './error-codes';
import { assessPrRisk, shouldRunSecondPass } from './review-risk';
import { mergeSecondPass, verifyReviewResult } from './finding-verifier';
import { getReviewState, recordReviewState } from './review-state';
import { isTrivialChangeSet } from './trivial-pr';
import {
  DEFAULT_DIFF_CHAR_BUDGET,
  buildCoverageManifest,
  planReviewFiles,
  type CoverageManifest,
} from './review-coverage';

// ── Workflow params (must be serializable — no functions, no DO stubs) ────────

export interface WorkflowParams {
  owner: string;
  repo: string;
  prNumber: number;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  installationId?: number;
  instruction?: string;
  focusFiles?: string[];
  githubToken?: string; // Push API: caller-provided token
  model?: string;       // Push API: override LLM model
  maxFiles?: number;    // Push API: override max files
  /** Run identity for fencing: assigned by the DO when this run was started.
   * Carried in the workflow PARAMS so a restarted older instance keeps its
   * own token instead of adopting the current owner's (plan 004-U1). */
  runId?: string;
}

// ── Intermediate data passed between steps ───────────────────────────────────

/** Serializable .donmerge resolution — Maps do not cross the step boundary. */
interface DonmergeDto {
  config: DonmergeConfig;
  skills: Array<[string, string]>;
  skillErrors: Array<[string, string]>;
}

function toDonmergeDto(resolved: DonmergeResolved): DonmergeDto {
  return {
    config: resolved.config,
    skills: Array.from(resolved.skillsContent.entries()),
    skillErrors: Array.from(resolved.skillsErrors.entries()),
  };
}

function fromDonmergeDto(dto: DonmergeDto): DonmergeResolved {
  return {
    config: dto.config,
    skillsContent: new Map(dto.skills),
    skillsErrors: new Map(dto.skillErrors),
  };
}

interface PrData {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  checkRunId: number;
  githubToken: string;
  prTitle?: string;
  prBody?: string | null;
  baseBranch?: string;
  /** When false, no review runs (skipped/guarded) — steps 2-4 short-circuit. */
  willReview: boolean;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  instruction?: string;
  focusFiles?: string[];
  model?: string;
  maxFiles?: number;
  /**
   * True when a human/API explicitly asked for THIS review (comment trigger,
   * focus files, instruction, Push-API token). Explicit requests are never
   * debounced, never trivial-skipped and always reviewed in full.
   */
  explicitRequest: boolean;
  /** PR base commit — anchors the snapshot alongside headSha. */
  baseSha?: string;
  /** PR-declared changed-file count — cross-checks discovery completeness. */
  changedFilesCount?: number;
  /** .donmerge config+skills resolved once in step 1 (serializable DTO). */
  donmerge?: DonmergeDto;
}

interface PreparedFiles {
  prData: PrData;
  diffText: string;
  repoContext: RepoContextType;
  donmerge?: DonmergeDto;
  /** Older in-flight workflows may still hold this field. */
  donmergeResolved?: DonmergeResolved;
  activePreviousComments: PreviousComment[];
  /** PR file patches captured in step 2, reused by step 4 for anchor validation. */
  filePatches: FilePatch[];
  /** What this run actually reviewed (plan 002): drives honest verdicts. */
  coverage: CoverageManifest;
  /**
   * Trivial change set (docs/lockfiles only, no high-risk signal): the run
   * completes a neutral check without an LLM pass (cost control).
   */
  trivialSkip?: { fileCount: number };
  /** Incremental re-review: no file changed since the last reviewed commit. */
  noChangesSinceReview?: boolean;
  /** Set on incremental re-reviews: diff covers commits since this SHA. */
  incrementalSince?: string;
}

interface LlmReviewResult {
  preparedFiles: PreparedFiles;
  result: ReviewResult;
}

// ── Env type for the workflow ────────────────────────────────────────────────

interface WorkflowEnv extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
}

// ── Workflow entrypoint ──────────────────────────────────────────────────────

export class CodeReviewWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const doName = `${params.owner}/${params.repo}/${params.prNumber}`;
    const processorStub = this.getProcessorStub(doName);

    // Fencing token for THIS run: carried in params (not read from the DO at
    // start) so a restarted older instance keeps its own identity and its
    // late writes are rejected instead of adopted (plan 004-U1).
    const runId: string | undefined = params.runId;

    // A superseded or terminal run must stop before creating a check, fetching
    // content or publishing anything. Rejection is explicit across the RPC.
    const accepted: boolean = await (processorStub as any).updateFromWorkflow({ state: 'running', runId });
    if (!accepted) {
      console.warn('Review workflow no longer owns the processor', { doName, runId });
      return;
    }

    let prData: PrData | undefined;

    try {
      // Step 1: Fetch PR data
      prData = await step.do('fetch-pr-data', {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      }, async () => {
        return this.fetchPrData(params);
      });

      if (!prData) {
        throw new Error('Failed to fetch PR data');
      }
      const activePrData = prData;

      // Skipped (wrong base) or guarded (contaminated diff): no LLM review.
      // Previously the wrong-base skip still burned a full LLM pass before the
      // publish step dropped it — short-circuit here instead.
      if (!activePrData.willReview) {
        // A base change still invalidates previous reviews even when we will
        // not re-review (e.g. base not allowed for this repo): mark them
        // superseded so the stale verdict cannot mislead readers.
        await supersedeBaseChangedReviews(
          activePrData.owner,
          activePrData.repo,
          activePrData.prNumber,
          activePrData.baseBranch,
          activePrData.githubToken
        );
        await (processorStub as any).updateFromWorkflow({
          state: 'complete',
          completedAt: new Date().toISOString(),
          runId,
        });
        return;
      }

      // Step 2: Prepare files
      const preparedFiles = await step.do('prepare-files', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      }, async () => {
        return this.prepareFiles(activePrData);
      });

      // Cost-control short-circuits (no LLM spend):
      //   - trivial change set (docs/lockfiles only, no explicit request)
      //   - incremental re-review with no file changes since the last review
      // Both complete a NEUTRAL check (never a green success: nothing was
      // verified by a model in this run) and record the DO as complete.
      if (preparedFiles.trivialSkip || preparedFiles.noChangesSinceReview) {
        const { owner, repo, headSha, checkRunId, githubToken } = preparedFiles.prData;
        await step.do('complete-skip-neutral', {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
          timeout: '1 minute',
        }, async () => {
          await this.assertSnapshotCurrent(activePrData);
          const title = preparedFiles.trivialSkip
            ? '📄 Trivial change — review skipped'
            : '📄 No file changes since last review';
          const summary = preparedFiles.trivialSkip
            ? `All ${preparedFiles.trivialSkip.fileCount} changed file(s) are docs/metadata/lockfiles — no code review needed.`
            : 'No file changed since the last reviewed commit — the previous verdict still stands.';
          const text = preparedFiles.trivialSkip
            ? 'DonMerge skips LLM reviews for change sets made only of documentation, metadata and lockfiles. ' +
              'Comment `@donmerge` to force a full review anyway.'
            : 'This push changed no files relative to the last fully reviewed commit. ' +
              'Comment `@donmerge` to force a full review anyway.';
          const missing = (preparedFiles.donmerge?.skillErrors ?? []).map(([path]) => path);
          await completeCheckRunNeutral(owner, repo, checkRunId, title, summary,
            missing.length ? `${text}\n\n${formatMissingPolicyFiles(missing)}` : text, githubToken);
        });
        await (processorStub as any).updateFromWorkflow({
          state: 'complete',
          completedAt: new Date().toISOString(),
          runId,
        });
        return;
      }

      // Step 3: Run LLM review
      const llmResult = await step.do('run-llm-review', {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '40 minutes',
      }, async () => {
        return this.runLlmReview(preparedFiles, runId);
      });

      // Persist the pre-publication snapshot across retries of the publication step.
      const previousCommentIds = await step.do('snapshot-review-comment-ids', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const { owner, repo, prNumber, githubToken } = llmResult.preparedFiles.prData;
        const comments = await fetchReviewComments(owner, repo, prNumber, githubToken);
        return comments.map((comment) => comment.id);
      });

      // Step 4: Publish review — retried with a 30s delay so an unresolved
      // ambiguous publication (marker not yet visible) gets a fresh marker
      // search well after GitHub's listing lag. A STILL-unresolved ambiguity
      // is terminal (manual verification): automated re-POST is disabled.
      await step.do('publish-review', {
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
        timeout: '3 minutes',
      }, async () => {
        try {
          return await this.publishReview(llmResult, processorStub, runId, previousCommentIds);
        } catch (error) {
          if (error instanceof Error && error.message.includes('publication unresolved')) {
            // Never retry an unproven POST: stop the step cold.
            throw new NonRetryableError(error.message);
          }
          throw error;
        }
      });
    } catch (error) {
      const { code, detail } = classifyError(error);
      console.error('CodeReviewWorkflow failed', {
        doName,
        code,
        detail,
      });

      let refreshQueued = false;
      if (code === ErrorCode.PR_CHANGED) {
        try {
          refreshQueued = await (processorStub as any).requestReviewRefresh(runId);
        } catch (refreshError) {
          console.error('Could not queue a fresh PR snapshot', refreshError);
        }
      }

      // Fail check run if we created one before the failure
      if (prData?.checkRunId) {
        try {
          if (code === ErrorCode.PR_CHANGED) {
            // The PR moved under us: a red X would blame the author's code for
            // an infrastructure race. Report neutrally and let the latest push
            // get its own run.
            await completeCheckRunNeutral(
              prData.owner,
              prData.repo,
              prData.checkRunId,
              '🔀 PR updated during review',
              `The PR head or destination changed while the review was running.`,
              refreshQueued
                ? `DonMerge stopped this run because the snapshot changed. A fresh review is queued.`
                : `DonMerge stopped this run because the snapshot changed. Comment \`@donmerge\` to re-trigger the review.`,
              prData.githubToken
            );
          } else if (code === ErrorCode.PUBLISH_UNRESOLVED) {
            // The review POST may or may not have reached GitHub. Automated
            // re-posting is disabled (it could duplicate the review): surface
            // a neutral, actionable check instead of a blind retry.
            await completeCheckRunNeutral(
              prData.owner,
              prData.repo,
              prData.checkRunId,
              '🔍 Review publication pending verification',
              `DonMerge could not confirm whether the review was posted to GitHub.`,
              `The review request may have reached GitHub but the confirmation was lost. To avoid posting a duplicate, DonMerge will NOT retry automatically.\n\n**Action:** check the PR's conversation for the review. If it is missing, comment \`@donmerge\` to re-run it.`,
              prData.githubToken
            );
          } else {
            await failCheckRun(
              prData.owner,
              prData.repo,
              prData.checkRunId,
              code,
              detail,
              prData.githubToken
            );
          }
        } catch (checkRunError) {
          console.error('Failed to fail check run on workflow error', { error: checkRunError });
        }
      }

      // Update DO status
      try {
        await (processorStub as any).updateFromWorkflow({
          state: 'failed',
          error: `[${code}] ${detail}`,
          completedAt: new Date().toISOString(),
          runId,
          headSha: prData?.headSha,
        });
      } catch (updateError) {
        console.error('Failed to update DO status on workflow error', { error: updateError });
      }

      // Re-throw so the Workflows platform marks the instance as failed
      throw error;
    }
  }

  // ── Step implementations ──────────────────────────────────────────────────

  private getProcessorStub(doName: string) {
    const id = this.env.ReviewProcessor.idFromName(doName);
    return this.env.ReviewProcessor.get(id);
  }

  private async assertSnapshotCurrent(prData: PrData): Promise<void> {
    const current = await githubFetch<{ head: { sha: string }; base: { ref: string; sha: string } }>(
      `https://api.github.com/repos/${prData.owner}/${prData.repo}/pulls/${prData.prNumber}`,
      prData.githubToken
    );
    if (current.head.sha !== prData.headSha) {
      throw new NonRetryableError(new PrHeadChangedError(prData.headSha, current.head.sha).message);
    }
    if (!prData.baseSha || !prData.baseBranch ||
        current.base.sha !== prData.baseSha || current.base.ref !== prData.baseBranch) {
      throw new NonRetryableError('PR base changed during review snapshot');
    }
  }

  /**
   * Step 1: Fetch PR data, create check run, fetch config.
   */
  private async fetchPrData(params: WorkflowParams): Promise<PrData> {
    const { owner, repo, prNumber } = params;

    // Explicit human/API request? Never debounced, never trivial-skipped,
    // always reviewed in full (comment trigger, focus files, instruction,
    // Push-API call with caller token).
    const explicitRequest = Boolean(
      params.githubToken || params.commentId || params.instruction || params.focusFiles?.length
    );

    // Resolve token
    let githubToken = params.githubToken;
    if (!githubToken) {
      githubToken = await resolveGitHubToken(this.env, params.installationId);
    }

    // Fetch PR info
    const pr = await githubFetch<{
      base: { ref: string; sha: string };
      head: { sha: string };
      title?: string;
      body?: string | null;
      changed_files?: number;
    }>(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, githubToken);

    // Check base branch
    const repoConfig = getRepoConfig(owner, repo, this.env.REPO_CONFIGS);
    if (repoConfig?.baseBranches && !repoConfig.baseBranches.includes(pr.base.ref)) {
      console.log('PR skipped - wrong base branch', {
        allowed: repoConfig.baseBranches,
        actual: pr.base.ref,
        repo: `${owner}/${repo}`,
      });
      // Return a special "skipped" result — the publish step will handle this
      return {
        owner,
        repo,
        prNumber,
        headSha: pr.head.sha,
        checkRunId: 0, // Will signal skip
        githubToken,
        prTitle: pr.title,
        prBody: pr.body,
        baseBranch: pr.base.ref,
        baseSha: pr.base.sha,
        changedFilesCount: pr.changed_files,
        willReview: false,
        retrigger: params.retrigger,
        commentId: params.commentId,
        commentType: params.commentType,
        instruction: params.instruction,
        focusFiles: params.focusFiles,
        model: params.model,
        maxFiles: params.maxFiles,
        explicitRequest,
      };
    }

    const headSha = pr.head.sha;

    // Divergence guard: when the head branch carries commits already merged via
    // other PRs (e.g. a fix branch based on master targeting develop), the
    // three-dot diff includes those unrelated changes and the review would
    // describe work this PR does not change. Surface a neutral check instead.
    const inheritedRefs = await fetchInheritedCommitRefs(
      owner,
      repo,
      pr.base.ref,
      headSha,
      prNumber,
      githubToken
    );
    if (inheritedRefs.length > 0) {
      console.log('PR diff contains commits inherited from base/head divergence', {
        base: pr.base.ref,
        inheritedRefs,
      });
      const guardCheckRun = await createCheckRun(owner, repo, headSha, githubToken);
      await completeCheckRunNeutral(
        owner,
        repo,
        guardCheckRun.id,
        '🔀 Diff contaminated by base/head divergence',
        `The diff includes changes already merged in ${inheritedRefs.join(', ')} — not authored in this PR.`,
        `The PR head branch contains commits from other merged PRs (${inheritedRefs.join(', ')}) ` +
          `because it diverged from base \`${pr.base.ref}\`.\n\n` +
          `Reviewing this diff would report findings on code this PR does not change.\n\n` +
          `**Fix:** rebase the branch onto \`${pr.base.ref}\` (or retarget the PR to the branch it ` +
          `was based on), then push or re-trigger with \`@donmerge\`.`,
        githubToken
      );
      return {
        owner,
        repo,
        prNumber,
        headSha,
        checkRunId: guardCheckRun.id,
        githubToken,
        prTitle: pr.title,
        prBody: pr.body,
        baseBranch: pr.base.ref,
        baseSha: pr.base.sha,
        changedFilesCount: pr.changed_files,
        willReview: false,
        retrigger: params.retrigger,
        commentId: params.commentId,
        commentType: params.commentType,
        instruction: params.instruction,
        focusFiles: params.focusFiles,
        model: params.model,
        maxFiles: params.maxFiles,
        explicitRequest,
      };
    }

    // Add eyes reaction
    if (params.commentId && params.commentType) {
      await addCommentReaction(owner, repo, params.commentId, params.commentType, githubToken);
    }

    // Create check run last — so retries after this point don't create duplicates
    const checkRun = await createCheckRun(owner, repo, headSha, githubToken);

    const prData: PrData = {
      owner,
      repo,
      prNumber,
      headSha,
      checkRunId: checkRun.id,
      githubToken,
      prTitle: pr.title,
      prBody: pr.body,
      baseBranch: pr.base.ref,
      baseSha: pr.base.sha,
      changedFilesCount: pr.changed_files,
      willReview: true,
      retrigger: params.retrigger,
      commentId: params.commentId,
      commentType: params.commentType,
      instruction: params.instruction,
      focusFiles: params.focusFiles,
      model: params.model,
      maxFiles: params.maxFiles,
      explicitRequest,
    };

    return prData;
  }

  /**
   * Step 2: Fetch PR files, apply filters, build diff, fetch repo context.
   *
   * Cost controls applied before any LLM spend:
   *   - trivial change sets (docs/lockfiles only, no explicit request) end the
   *     run here with a neutral check (handled by the caller via `trivialSkip`)
   *   - retriggers after a fully-reviewed SHA review only the files changed
   *     since that commit (`incrementalSince`), with full-diff fallback on any
   *     doubt about the compare range.
   */
  private async prepareFiles(prData: PrData): Promise<PreparedFiles> {
    const { owner, repo, prNumber, githubToken } = prData;

    // Discover every file in the PR (all pages) for a versioned snapshot.
    const declaredCount = prData.changedFilesCount ?? 0;
    const discovery = await fetchAllPrFiles(owner, repo, prNumber, githubToken, declaredCount);

    // The listing describes a mutable PR: if the head moved while paginating,
    // this snapshot would mix two versions of the diff. Non-retryable — a step
    // retry replays with the same cached PR data and would loop; the latest
    // push gets its own run.
    await this.assertSnapshotCurrent(prData);

    const maxFiles = prData.maxFiles ?? Number.parseInt(this.env.MAX_REVIEW_FILES ?? '50', 10);

    if (!prData.baseSha) throw new Error('Cannot load review policy without the base SHA');
    let config: DonmergeConfig | null;
    let donmergeResolved: DonmergeResolved | undefined;
    try {
      config = await fetchDonmergeConfig(owner, repo, githubToken, fetchPolicyFile, prData.baseSha, true);
      donmergeResolved = config
        ? await resolveDonmergeSkills(config, owner, repo, githubToken, fetchPolicyFile, prData.baseSha, true)
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const http = message.match(/GitHub API error (\d{3})/);
      const reason = message.startsWith('Failed to load policy skills:')
        ? 'One or more declared policy files could not be read or exceeded the size limit.'
        : http ? `GitHub returned HTTP ${http[1]} while reading the destination policy.`
          : 'The destination .donmerge is invalid or could not be read.';
      throw new Error(`[POLICY_UNAVAILABLE] ${reason}`);
    }

    // ── Cost control: trivial change sets ──────────────────────────────────
    // Docs/lockfile-only PRs get no LLM pass. Explicit human requests
    // (comment/focus/instruction/Push API) always review.
    if (
      this.env.DONMERGE_SKIP_TRIVIAL !== 'false' &&
      !prData.explicitRequest &&
      !discovery.files.some(file =>
        ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'DEVELOPMENT.md', '.donmerge'].includes(file.filename) ||
        config?.skills?.some(skill => skill.path === file.filename)
      ) &&
      isTrivialChangeSet({ files: discovery.files })
    ) {
      console.log('[trivial-skip] whole change set is trivial — no LLM review', {
        files: discovery.files.length,
      });
      const plan = planReviewFiles({
        discovered: discovery.files,
        focusFiles: undefined,
        isExcluded: () => false,
        maxFiles,
        diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
      });
      return {
        prData,
        diffText: '',
        repoContext: {},
        donmerge: donmergeResolved ? toDonmergeDto(donmergeResolved) : undefined,
        activePreviousComments: [],
        filePatches: [],
        coverage: buildCoverageManifest(plan, {
          headSha: prData.headSha,
          baseSha: prData.baseSha,
          changedFilesCount: declaredCount,
          apiFileCapReached: discovery.apiFileCapReached,
        }),
        trivialSkip: { fileCount: discovery.files.length },
      };
    }

    // ── Cost control: incremental re-review ────────────────────────────────
    // A retrigger after a FULLY-reviewed commit only needs the files changed
    // since that commit. Any doubt (no state, partial previous coverage, base
    // changed, force-push, compare failure, 300-file cap) falls back to the
    // full PR diff — an incomplete incremental scope is worse than a full run.
    let discovered = discovery.files;
    let incrementalSince: string | undefined;
    let apiFileCapReached = discovery.apiFileCapReached;
    if (
      prData.retrigger &&
      !prData.explicitRequest &&
      !donmergeResolved?.skillsErrors.size &&
      this.env.DONMERGE_INCREMENTAL_REVIEW !== 'false' &&
      this.env.DB
    ) {
      try {
        const state = await getReviewState(this.env.DB, owner, repo, prNumber);
        if (
          state &&
          state.fullCoverage &&
          state.baseRef === (prData.baseBranch ?? '') &&
          Boolean(prData.baseSha) &&
          state.baseSha === prData.baseSha &&
          state.lastReviewedSha !== prData.headSha
        ) {
          const between = await fetchPrFilesBetween(
            owner,
            repo,
            state.lastReviewedSha,
            prData.headSha,
            githubToken
          );
          if (between.usable && between.files.length === 0) {
            console.log('[incremental] no file changes since last reviewed commit', {
              sinceSha: state.lastReviewedSha,
            });
            return {
              prData,
              diffText: '',
              repoContext: {},
              activePreviousComments: [],
              filePatches: [],
              coverage: buildCoverageManifest(
                {
                  selected: [],
                  entries: [],
                  focusNoMatch: false,
                  focused: false,
                  diffTruncated: false,
                },
                {
                  headSha: prData.headSha,
                  baseSha: prData.baseSha,
                  changedFilesCount: 0,
                  apiFileCapReached: false,
                  incrementalSince: state.lastReviewedSha,
                }
              ),
              incrementalSince: state.lastReviewedSha,
              noChangesSinceReview: true,
            };
          }
          if (between.usable && between.files.length > 0) {
            discovered = between.files;
            incrementalSince = state.lastReviewedSha;
            apiFileCapReached = false;
            console.log('[incremental] reviewing only commits since last reviewed SHA', {
              sinceSha: state.lastReviewedSha,
              incrementalFiles: between.files.length,
              fullPrFiles: discovery.files.length,
            });
          }
        }
      } catch (error) {
        console.warn('[incremental] state check failed — full review', {
          owner,
          repo,
          prNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Plan which files actually reach the prompt (plan 002): focus scope
    // first (explicit, never silently widened), then .donmerge policy, then
    // file-count and diff-character budgets. Whole files only — no mid-hunk
    // truncation, and every left-out file is recorded with a reason.
    const plan = planReviewFiles({
      discovered,
      focusFiles: prData.focusFiles,
      isExcluded: (path) => {
        const excludePatterns = donmergeResolved?.config.exclude ?? [];
        const includePatterns = donmergeResolved?.config.include ?? [];
        if (excludePatterns.length === 0) return false;
        try {
          return shouldExcludeFile(path, excludePatterns, includePatterns);
        } catch (error) {
          console.warn('[donmerge] File filtering failed, treating file as included:', error);
          return false;
        }
      },
      maxFiles,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });

    const coverage = buildCoverageManifest(plan, {
      headSha: prData.headSha,
      baseSha: prData.baseSha,
      changedFilesCount: declaredCount,
      apiFileCapReached,
      incrementalSince,
    });

    if (!coverage.scopeComplete) {
      console.log('[coverage] Review scope is partial', {
        reviewed: coverage.reviewedCount,
        discovered: coverage.discoveredCount,
        declared: coverage.changedFilesCount,
        pending: coverage.pendingCount,
        focused: coverage.focused,
        focusNoMatch: coverage.focusNoMatch,
        diffTruncated: coverage.diffTruncated,
        apiFileCapReached: coverage.apiFileCapReached,
        incremental: incrementalSince ?? false,
      });
    }

    const filesToReview = plan.selected;
    const diffText = filesToReview
      .map((file) => `FILE: ${file.filename}\n${file.patch}\n`)
      .join('\n');

    // Fetch repo context at the reviewed head (plan 005-U1: explicit ref).
    let repoContext: RepoContextType;
    try {
      repoContext = await fetchRepoContext(owner, repo, prData.headSha, githubToken, prData.baseSha);
    } catch {
      throw new Error('[POLICY_UNAVAILABLE] A destination policy guide could not be read from GitHub.');
    }

    // Fetch previous comments if retrigger
    let activePreviousComments: PreviousComment[] = [];
    if (prData.retrigger) {
      const previousComments = await fetchPreviousDonMergeComments(owner, repo, prNumber, githubToken);
      activePreviousComments = previousComments.filter((comment) => !comment.resolved);
      console.log('Found previous comments', { count: activePreviousComments.length });
    }

    return {
      prData,
      diffText,
      repoContext,
      donmerge: donmergeResolved ? toDonmergeDto(donmergeResolved) : undefined,
      activePreviousComments,
      // Capture the reviewed file patches so step 4 can validate comment anchors
      // without re-fetching listFiles. plan.selected is the filtered set the LLM
      // actually saw, so it is the correct anchor scope.
      filePatches: filesToReview.map((file) => ({
        filename: file.filename,
        patch: file.patch,
      })),
      coverage,
      incrementalSince,
    };
  }

  /**
   * Step 3: Run LLM review via Sandbox + Flue.
   *
   * The review-model-runner owns model ordering and format retries. This module
   * owns only memory/config loading, sandbox lifecycle, and prompt construction.
   */
  private async runLlmReview(preparedFiles: PreparedFiles, runId?: string): Promise<LlmReviewResult> {
    const { prData, diffText, repoContext, activePreviousComments } = preparedFiles;
    const donmergeResolved = preparedFiles.donmerge
      ? fromDonmergeDto(preparedFiles.donmerge)
      : preparedFiles.donmergeResolved;

    // Load memory context and pattern weights (best-effort)
    let memoryContext: MemoryContext | undefined;
    let patternWeights: Map<string, PatternWeight> | undefined;
    if (this.env.DB) {
      try {
        memoryContext = await buildMemoryContext(
          this.env.DB, prData.owner, prData.repo, preparedFiles.filePatches.map(file => file.filename),
          scopedMemoryEnabledForRepo(this.env, prData.owner, prData.repo)
        );
        const weights = await getPatternWeights(this.env.DB, prData.owner, prData.repo);
        // Historical dismissal weights have no maintainer approval or file
        // scope. They cannot suppress or demote findings across a repository.
        patternWeights = new Map([...weights].filter(([, weight]) => weight.confidence >= 0.4));
      } catch (e) {
        if (isMissingMemorySchema(e)) {
          throw new NonRetryableError('Review memory schema is missing; apply D1 migration 0009 before reviewing.');
        }
        console.warn('[memory] Failed to load memory context, proceeding without:', e);
      }
    }

    const sessionId = `review-${prData.owner}-${prData.repo}-${prData.prNumber}-${Date.now()}`;
    const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: SANDBOX_SLEEP_AFTER });
    const gatewayEnabled = aiGatewayEnabled(this.env);
    const directProviderConfig = buildOpencodeConfig(this.env.KIMI_API_KEY, this.env.GLM_API_KEY);
    const opencodeConfig = gatewayEnabled
      ? {
          provider: {
            ...buildAiGatewayOpencodeConfig(this.env).provider,
            ...directProviderConfig.provider,
          },
        }
      : directProviderConfig;
    const flue = new FlueRuntime({
      sandbox,
      sessionId,
      workdir: '/home/user',
      // Try the gateway first, then keep direct providers available when the
      // gateway hangs or its entire upstream chain is unavailable.
      opencodeConfig,
    });

    try {
      await sandbox.setEnvVars({
        OPENAI_API_KEY: this.env.OPENAI_API_KEY,
        KIMI_API_KEY: this.env.KIMI_API_KEY,
        GLM_API_KEY: this.env.GLM_API_KEY,
        GITHUB_TOKEN: prData.githubToken,
      });
      await flue.setup();

      const primaryModel = prData.model
        ? parseModelConfig(prData.model)
        : parseModelConfig(this.env.CODEX_MODEL);
      const fallbackModel = resolveFallbackModel(this.env.FALLBACK_MODEL);
      const models: ModelConfig[] = resolveReviewModels({
        primaryModel,
        gatewayModel: gatewayEnabled
          ? { providerID: AI_GATEWAY_PROVIDER_ID, modelID: aiGatewayModelId(this.env.CF_AI_GATEWAY_ROUTE!) }
          : undefined,
        glmApiKey: this.env.GLM_API_KEY,
        fallbackModel,
      });

      // Optional host-side file context (plan 003-U1): full reviewed files at
      // head as untrusted data, so the model can check guards/callers the
      // diff hides. Budgeted; off by default (DONMERGE_FILE_CONTEXT).
      let fileContents: Array<{ path: string; content: string }> | undefined;
      if (this.env.DONMERGE_FILE_CONTEXT === 'true') {
        fileContents = await fetchFileContentsAtRef(
          prData.owner,
          prData.repo,
          preparedFiles.filePatches.map((f) => f.filename),
          prData.headSha,
          prData.githubToken,
          { maxFiles: 8, maxCharsPerFile: 20_000, maxCharsTotal: 60_000 }
        );
        console.log('[file-context] loaded full files at head', {
          count: fileContents.length,
        });
      }

      const prompt = buildReviewPrompt(
        {
          owner: prData.owner,
          repo: prData.repo,
          prNumber: prData.prNumber,
          prTitle: prData.prTitle,
          prBody: prData.prBody,
          retrigger: prData.retrigger,
          instruction: prData.instruction,
          previousComments: activePreviousComments,
          diffText,
          repoContext,
          incrementalSince: preparedFiles.incrementalSince,
        },
        {
          donmergeResolved,
          memoryContext,
          adversarial: this.env.DONMERGE_ADVERSARIAL_PROMPT === 'true',
          fileContents,
        }
      );

      const promptErrorHint =
        'Your previous response was invalid. Produce valid JSON matching the schema. ' +
        'Ensure `summary` is present and 1-2 sentences. Ensure `prSummary` includes overview, keyChanges (non-empty), codeQuality, testingNotes, riskAssessment. ' +
        'The arrays `lineComments`, `criticalIssues` and `suggestions` MUST all be present (use [] when empty). ' +
        'Each lineComment needs a positive integer `line`, side LEFT or RIGHT, severity critical/suggestion/low, and a non-empty path and body. ' +
        'Only use `lineComments` for concrete findings anchored to lines in the diff.';

      // End-to-end model budget (plan 004-U2): once the run is out of budget,
      // no new prompts start — the step fails honestly instead of running past
      // its own timeout and getting killed mid-flight.
      const budgetFromEnv = Number.parseInt(this.env.REVIEW_TOTAL_BUDGET_MS ?? '', 10);
      const totalBudgetMs = Number.isFinite(budgetFromEnv) && budgetFromEnv > 0
        ? budgetFromEnv
        : DEFAULT_REVIEW_TOTAL_BUDGET_MS;
      const deadlineMs = Date.now() + totalBudgetMs;

      let result = await runReviewModels({
        flue,
        prompt,
        promptErrorHint,
        models,
        activePreviousComments,
        severityOverrides: donmergeResolved?.config.severity,
        patternWeights,
        deadlineMs,
      });

      // ── Adaptive depth (plan 003), feature-flagged OFF by default ──
      const risk = assessPrRisk(preparedFiles.filePatches);
      console.log('[risk] assessed', { level: risk.level, reasons: risk.reasons });

      // High-risk + clean first pass → independent second search that has not
      // seen the first pass's reasoning. Unknown risk never downgrades.
      if (
        this.env.DONMERGE_SECOND_PASS === 'true' &&
        shouldRunSecondPass(risk, hasBlockingFindings(result))
      ) {
        console.log('[second-pass] high-risk change reviewed clean; running independent pass', {
          reasons: risk.reasons,
        });
        const secondPrompt = buildReviewPrompt(
          {
            owner: prData.owner,
            repo: prData.repo,
            prNumber: prData.prNumber,
            prTitle: prData.prTitle,
            prBody: prData.prBody,
            retrigger: prData.retrigger,
            instruction: prData.instruction,
            previousComments: activePreviousComments,
            diffText,
            repoContext,
          },
          {
            donmergeResolved,
            memoryContext,
            secondPass: true,
            adversarial: this.env.DONMERGE_ADVERSARIAL_PROMPT === 'true',
            fileContents,
          }
        );
        const second = await runReviewModels({
          flue,
          prompt: secondPrompt,
          promptErrorHint,
          models,
          activePreviousComments,
          severityOverrides: donmergeResolved?.config.severity,
          patternWeights,
          deadlineMs,
        });
        result = mergeSecondPass(result, second);
      }

      // Independent verification: attempt to REFUTE every critical finding.
      // Only `supported` findings survive to publish; withheld ones are
      // reported as unverified limitations, never silently dropped.
      if (this.env.DONMERGE_VERIFY_FINDINGS === 'true') {
        const verified = await verifyReviewResult({
          promptFn: (p: string, opts: unknown) =>
            flue.client.prompt(p, opts as never) as Promise<string>,
          model: models[0],
          repo: prData.repo,
          diffText,
          result,
        });
        if (verified.notes.length > 0) {
          console.log('[verifier] withheld unconfirmed findings', {
            count: verified.notes.length,
          });
        }
        result = verified.result;
      }

      if (this.env.DB && memoryContext) {
        try {
          const citations = citedLearningIds(JSON.stringify(result));
          const snapshotRunId = runId ?? `check-${prData.checkRunId}`;
          const statement = this.env.DB.prepare(`INSERT INTO review_learning_snapshots
            (owner, repo, pr_number, head_sha, run_id, learning_id, learning_text, scope_type, scope_path, cited)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          await this.env.DB.batch([
            this.env.DB.prepare(`DELETE FROM review_learning_snapshots
              WHERE owner = ? AND repo = ? AND pr_number = ? AND run_id = ?`)
              .bind(prData.owner, prData.repo, prData.prNumber, snapshotRunId),
            ...(memoryContext.scopedLearnings ?? []).map(learning => statement.bind(
              prData.owner, prData.repo, prData.prNumber, prData.headSha, snapshotRunId, learning.id,
              learning.learning_text, learning.scope_type, learning.scope_path,
              citations.has(learning.id) ? 1 : 0
            )),
          ]);
        } catch (error) {
          console.warn('[memory] Failed to record citations', error);
        }
      }

      return { preparedFiles, result };
    } catch (error) {
      if (error instanceof AllModelsFailedError) {
        // A dead sandbox DO reads as a failure on every model (e.g. "this
        // Durable Object instance is no longer active"). A fresh sandbox on
        // step replay usually recovers it, so keep those retryable.
        if (error.hasTransientSandboxFailures()) {
          throw error;
        }
        // Model/provider failures are already exhausted locally. Do not let
        // the durable step replay the same quality-repair/fallback chain.
        throw new NonRetryableError(error.message);
      }
      // Sandbox setup and other unclassified infrastructure failures remain
      // retryable through the Workflow step policy.
      throw error;
    } finally {
      await destroySandbox(sandbox, 'code-review');
    }
  }

  /**
   * Step 4: Publish review, update tracked issues, complete check run.
   */
  private async publishReview(
    llmResult: LlmReviewResult,
    processorStub: DurableObjectStub,
    runId?: string,
    previousCommentIds?: number[] | null
  ): Promise<void> {
    const { preparedFiles, result } = llmResult;
    const { prData, activePreviousComments } = preparedFiles;
    const { owner, repo, prNumber, headSha, checkRunId, githubToken } = prData;
    const missingPolicyFiles = preparedFiles.donmerge
      ? preparedFiles.donmerge.skillErrors.map(([path]) => path)
      : [...(preparedFiles.donmergeResolved?.skillsErrors.keys() ?? [])];

    // Skip if checkRunId is 0 (base branch mismatch)
    if (checkRunId === 0) {
      await (processorStub as any).updateFromWorkflow({
        state: 'complete',
        completedAt: new Date().toISOString(),
        runId,
      });
      return;
    }

    await this.assertSnapshotCurrent(prData);

    // Load tracked issues from DO via RPC
    const storedIssues: TrackedIssue[] = await (processorStub as any).loadTrackedIssuesRpc();

    // Absence from model output is never proof that a finding is fixed.
    const context: IssueBuilderContext = { repo, prNumber };
    const currentIssues = await buildCurrentIssues(context, headSha, result.lineComments);
    const matchResult = matchCurrentFindingsToStored(currentIssues, storedIssues, {
      assumeMissingResolved: false,
    });

    // Update tracked issues in DO via RPC
    const updatedIssues = new Map<string, TrackedIssue>();
    for (const issue of storedIssues) {
      updatedIssues.set(issue.id, issue);
    }
    for (const issue of matchResult.persistingIssues) {
      updatedIssues.set(issue.id, transitionToOpen(issue, headSha));
    }
    for (const issue of matchResult.reintroducedIssues) {
      updatedIssues.set(issue.id, transitionToReintroduced(issue, headSha));
    }
    for (const issue of matchResult.newIssues) {
      updatedIssues.set(issue.id, transitionToNew(issue, headSha));
    }

    // Filter comments + blocking approval
    const reintroduced = currentIssues.filter((issue) => matchResult.matchedIssues.get(issue)?.status === 'fixed');
    const filteredResult = withBlockingApproval({
      ...result,
      lineComments: filterCommentsByMatch(
        result.lineComments,
        currentIssues.map((ci) => ci.fingerprint),
        currentIssues.map((ci) => ci.logicalKey),
        [...matchResult.newIssues.map((i) => i.fingerprint), ...reintroduced.map((issue) => issue.fingerprint)],
        []
      ),
    });

    // Approval gate: never approve while prior DonMerge threads are unresolved.
    // Degrades (approved -> false, blocking REQUEST_CHANGES) rather than throwing,
    // so valid new findings still post. activePreviousComments is pre-filtered
    // to unresolved + DonMerge-authored in step 2.
    const gated = applyApprovalGate(filteredResult, activePreviousComments);
    if (gated.overridden) {
      console.log('Approval gated by outstanding threads', {
        outstandingCount: gated.outstandingCount,
      });
    }

    const reviewForPublication = missingPolicyFiles.length
      ? { ...gated.review, summary: `${gated.review.summary}\n\n${formatMissingPolicyFiles(missingPolicyFiles)}` }
      : gated.review;

    // Publish review (validates anchors against threaded patches; returns dropped comments)
    let expectedComments: Array<{ path: string; fingerprint: string }> = [];
    const droppedComments = await publishReview(
      owner,
      repo,
      prNumber,
      headSha,
      reviewForPublication,
      githubToken,
      activePreviousComments,
      preparedFiles.filePatches,
      prData.baseBranch,
      runId,
      {},
      runId ? () => (processorStub as any).reservePublication(runId) : undefined,
      (comments) => { expectedComments = comments; },
      new Set(reintroduced.map((issue) => issue.fingerprint))
    );

    // Fetch published inline comments once. D1 memory needs their GitHub IDs
    // to authenticate replies later (the marker alone is user-forgeable).
    let publishedComments: Awaited<ReturnType<typeof fetchReviewComments>> = [];
    if (currentIssues.length > 0) {
      publishedComments = await fetchReviewComments(owner, repo, prNumber, githubToken);
    }

    // Only comments absent from the complete pre-publication snapshot are new.
    const outcomeInputs = buildReviewOutcomeInputs(
      currentIssues,
      newlyPublishedComments(previousCommentIds ? new Set(previousCommentIds) : undefined, publishedComments)
    );

    // GitHub listing can lag publication; never finalize a missing correlation.
    for (const expected of expectedComments) {
      if (!outcomeInputs.some((outcome) => outcome.filePath === expected.path && outcome.fingerprint === expected.fingerprint && outcome.githubCommentId)) {
        throw new Error('Published review comment is not yet visible for memory correlation');
      }
    }
    if (expectedComments.length > 0 && !this.env.DB) {
      throw new Error('D1 is required to correlate published review comments');
    }
    if (this.env.DB) {
      await recordReviewFindings(this.env.DB, {
        owner,
        repo,
        prNumber,
        headSha,
        findings: outcomeInputs.filter((outcome) => outcome.githubCommentId),
      });
    }

    // Unpublished findings must remain eligible on a later run (invalid
    // anchors and the inline limit can prevent an otherwise valid finding).
    for (const issue of matchResult.newIssues) {
      if (!outcomeInputs.some((outcome) => outcome.fingerprint === issue.fingerprint && outcome.githubCommentId)) {
        updatedIssues.delete(issue.id);
      }
    }
    for (const issue of matchResult.reintroducedIssues) {
      const wasPublished = currentIssues.some((current, index) =>
        matchResult.matchedIssues.get(current)?.id === issue.id && outcomeInputs[index].githubCommentId
      );
      if (!wasPublished) updatedIssues.set(issue.id, issue);
    }

    // Fingerprints identify semantic findings, not publication instances: a
    // reintroduction with the same identity keeps its fingerprint but gets a
    // fresh verified comment ID. Persist both with the transition in one RPC.
    for (const [index, current] of currentIssues.entries()) {
      const commentId = outcomeInputs[index].githubCommentId;
      if (!commentId) continue;
      const existing = matchResult.matchedIssues.get(current);
      const issueId = existing?.id ?? current.payload.id;
      const updated = updatedIssues.get(issueId);
      if (updated) updatedIssues.set(issueId, {
        ...updated,
        fingerprint: current.fingerprint,
        logicalKey: current.logicalKey,
        anchorKey: current.anchorKey,
        ruleId: current.payload.ruleId,
        entityType: current.payload.entityType,
        symbolName: current.payload.symbolName,
        filePath: current.payload.filePath,
        line: current.payload.line,
        side: current.payload.side,
        snippetHash: current.payload.snippetHash,
        body: current.payload.body,
        severity: current.payload.severity,
        githubCommentId: commentId,
      });
    }
    await (processorStub as any).saveTrackedIssuesRpc(Array.from(updatedIssues.values()), runId);

    // Complete check run (surfaces dropped comments when present; honest
    // conclusion about scope — neutral, not green, for partial reviews)
    await completeCheckRun(
      owner,
      repo,
      checkRunId,
      reviewForPublication,
      githubToken,
      droppedComments,
      preparedFiles.coverage,
      missingPolicyFiles
    );

    // Update PR description
    await updatePRDescription(owner, repo, prNumber, reviewForPublication, githubToken, preparedFiles.coverage, missingPolicyFiles);

    // Record review state (cost control): the next push can review only the
    // commits since this SHA — but only when THIS run covered its whole scope.
    // Partial runs record fullCoverage = 0 so a later push falls back to a
    // full review instead of stacking an incomplete verdict. Best-effort: a
    // D1 failure here only costs the next run its incremental shortcut.
    if (this.env.DB) {
      try {
        await recordReviewState(this.env.DB, {
          owner,
          repo,
          prNumber,
          baseRef: prData.baseBranch,
          baseSha: prData.baseSha,
          headSha,
          fullCoverage: preparedFiles.coverage.scopeComplete && missingPolicyFiles.length === 0,
        });
      } catch (error) {
        console.warn('[review-state] failed to record review state', {
          owner,
          repo,
          prNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Update DO status
    await (processorStub as any).updateFromWorkflow({
      state: 'complete',
      completedAt: new Date().toISOString(),
      result: reviewForPublication,
      runId,
      headSha,
    });

    console.log('Review completed successfully', {
      owner,
      repo,
      prNumber,
      approved: gated.review.approved,
      approvalOverridden: gated.overridden,
    });
  }
}
