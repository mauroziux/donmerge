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
  fetchRepoFile,
  fetchAllPrFiles,
  fetchPrHeadSha,
  fetchFileContentsAtRef,
  resolveFixedComments,
  publishReview,
  completeCheckRun,
  completeCheckRunNeutral,
  fetchInheritedCommitRefs,
  supersedeBaseChangedReviews,
  updatePRDescription,
} from './github-api';
import { resolveGitHubToken } from './github-auth';
import { buildCurrentIssues, type IssueBuilderContext } from './issue-builder';
import { matchCurrentFindingsToStored } from './issue-matcher';
import { transitionToFixed, transitionToNew, transitionToOpen, transitionToReintroduced } from './issue-lifecycle';
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
  syncTrackedIssuesFromComments,
  withBlockingApproval,
  hasBlockingFindings,
} from './processor-utils';
import { recordReviewFindings } from './feedback-handler';
import { buildMemoryContext, getPatternWeights } from './memory-store';
import { destroySandbox, SANDBOX_SLEEP_AFTER } from '../../lib/sandbox-lifecycle';
import { AllModelsFailedError, runReviewModels, DEFAULT_REVIEW_TOTAL_BUDGET_MS } from './review-model-runner';
import { PrHeadChangedError } from './review-snapshot';
import { ErrorCode } from './error-codes';
import { assessPrRisk, shouldRunSecondPass } from './review-risk';
import { mergeSecondPass, verifyReviewResult } from './finding-verifier';
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
  donmergeResolved?: DonmergeResolved;
  activePreviousComments: PreviousComment[];
  /** PR file patches captured in step 2, reused by step 4 for anchor validation. */
  filePatches: FilePatch[];
  /** What this run actually reviewed (plan 002): drives honest verdicts. */
  coverage: CoverageManifest;
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

      // Step 3: Run LLM review
      const llmResult = await step.do('run-llm-review', {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '40 minutes',
      }, async () => {
        return this.runLlmReview(preparedFiles);
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
          return await this.publishReview(llmResult, processorStub, runId);
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
              `The PR received new commits while the review was running.`,
              `DonMerge stopped this run instead of reporting on a stale version of the diff.\n\nThe latest push will be reviewed; you can also comment \`@donmerge\` to re-trigger immediately.`,
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

  /**
   * Step 1: Fetch PR data, create check run, fetch config.
   */
  private async fetchPrData(params: WorkflowParams): Promise<PrData> {
    const { owner, repo, prNumber } = params;

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
      };
    }

    // Fetch .donmerge config (best-effort)
    let donmergeResolved: DonmergeResolved | undefined;
    try {
      const donmergeConfig = await fetchDonmergeConfig(owner, repo, githubToken, fetchRepoFile);
      if (donmergeConfig) {
        console.log('[donmerge] Loaded config', {
          exclude: donmergeConfig.exclude?.length ?? 0,
          include: donmergeConfig.include?.length ?? 0,
          skills: donmergeConfig.skills?.length ?? 0,
          severity: donmergeConfig.severity ? Object.keys(donmergeConfig.severity).length : 0,
        });
        donmergeResolved = { config: donmergeConfig, skillsContent: new Map(), skillsErrors: new Map() };
      }
    } catch (error) {
      console.warn('[donmerge] Failed to fetch config, continuing without it:', error);
    }

    // Add eyes reaction
    if (params.commentId && params.commentType) {
      await addCommentReaction(owner, repo, params.commentId, params.commentType, githubToken);
    }

    // Resolve .donmerge skills
    if (donmergeResolved && donmergeResolved.config.skills && donmergeResolved.config.skills.length > 0) {
      try {
        donmergeResolved = await resolveDonmergeSkills(
          donmergeResolved.config, owner, repo, githubToken, fetchRepoFile
        );
        console.log('[donmerge] Resolved skills', {
          loaded: donmergeResolved.skillsContent.size,
          errors: donmergeResolved.skillsErrors.size,
        });
      } catch (error) {
        console.warn('[donmerge] Skill resolution failed, continuing without skills:', error);
      }
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
      donmerge: donmergeResolved ? toDonmergeDto(donmergeResolved) : undefined,
      willReview: true,
      retrigger: params.retrigger,
      commentId: params.commentId,
      commentType: params.commentType,
      instruction: params.instruction,
      focusFiles: params.focusFiles,
      model: params.model,
      maxFiles: params.maxFiles,
    };

    return prData;
  }

  /**
   * Step 2: Fetch PR files, apply filters, build diff, fetch repo context.
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
    const currentHead = await fetchPrHeadSha(owner, repo, prNumber, githubToken);
    if (currentHead !== prData.headSha) {
      throw new NonRetryableError(
        new PrHeadChangedError(prData.headSha, currentHead).message
      );
    }

    const maxFiles = prData.maxFiles ?? Number.parseInt(this.env.MAX_REVIEW_FILES ?? '50', 10);

    // Reuse the .donmerge config+skills resolved in step 1 (plan 005-U1: no
    // double fetch/re-resolve per run). Rehydrate the serializable DTO.
    const donmergeResolved: DonmergeResolved | undefined = prData.donmerge
      ? fromDonmergeDto(prData.donmerge)
      : undefined;

    // Plan which files actually reach the prompt (plan 002): focus scope
    // first (explicit, never silently widened), then .donmerge policy, then
    // file-count and diff-character budgets. Whole files only — no mid-hunk
    // truncation, and every left-out file is recorded with a reason.
    const plan = planReviewFiles({
      discovered: discovery.files,
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
      changedFilesCount: declaredCount,
      apiFileCapReached: discovery.apiFileCapReached,
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
      });
    }

    const filesToReview = plan.selected;
    const diffText = filesToReview
      .map((file) => `FILE: ${file.filename}\n${file.patch}\n`)
      .join('\n');

    // Fetch repo context at the reviewed head (plan 005-U1: explicit ref).
    const repoContext = await fetchRepoContext(owner, repo, prData.headSha, githubToken);

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
      donmergeResolved,
      activePreviousComments,
      // Capture the reviewed file patches so step 4 can validate comment anchors
      // without re-fetching listFiles. plan.selected is the filtered set the LLM
      // actually saw, so it is the correct anchor scope.
      filePatches: filesToReview.map((file) => ({
        filename: file.filename,
        patch: file.patch,
      })),
      coverage,
    };
  }

  /**
   * Step 3: Run LLM review via Sandbox + Flue.
   *
   * The review-model-runner owns model ordering and format retries. This module
   * owns only memory/config loading, sandbox lifecycle, and prompt construction.
   */
  private async runLlmReview(preparedFiles: PreparedFiles): Promise<LlmReviewResult> {
    const { prData, diffText, repoContext, donmergeResolved, activePreviousComments } = preparedFiles;

    // Load memory context and pattern weights (best-effort)
    let memoryContext: MemoryContext | undefined;
    let patternWeights: Map<string, PatternWeight> | undefined;
    if (this.env.DB) {
      try {
        memoryContext = await buildMemoryContext(this.env.DB, prData.owner, prData.repo);
        patternWeights = await getPatternWeights(this.env.DB, prData.owner, prData.repo);
      } catch (e) {
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
    runId?: string
  ): Promise<void> {
    const { preparedFiles, result } = llmResult;
    const { prData, activePreviousComments } = preparedFiles;
    const { owner, repo, prNumber, headSha, checkRunId, githubToken } = prData;

    // Skip if checkRunId is 0 (base branch mismatch)
    if (checkRunId === 0) {
      await (processorStub as any).updateFromWorkflow({
        state: 'complete',
        completedAt: new Date().toISOString(),
        runId,
      });
      return;
    }

    // Load tracked issues from DO via RPC
    let storedIssues: TrackedIssue[] = await (processorStub as any).loadTrackedIssuesRpc();
    if (activePreviousComments.length > 0 && storedIssues.length > 0) {
      storedIssues = syncTrackedIssuesFromComments(storedIssues, activePreviousComments);
    }

    // Build current issues + match. A partial/focused run must not interpret
    // "issue not observed" as "fixed" (plan 002-U4): only a full-scope run may
    // auto-resolve unmatched open issues.
    const context: IssueBuilderContext = { repo, prNumber };
    const currentIssues = await buildCurrentIssues(context, headSha, result.lineComments);
    const matchResult = matchCurrentFindingsToStored(currentIssues, storedIssues, {
      assumeMissingResolved: preparedFiles.coverage.scopeComplete,
      // Only issues in files this run actually reviewed may auto-resolve; a
      // policy-excluded file was never assessed (plan 002-U4 hardening).
      reviewedPaths: new Set(preparedFiles.filePatches.map((f) => f.filename)),
    });

    // Update tracked issues in DO via RPC
    const updatedIssues = new Map<string, TrackedIssue>();
    for (const issue of storedIssues) {
      updatedIssues.set(issue.id, issue);
    }
    for (const issue of matchResult.persistingIssues) {
      updatedIssues.set(issue.id, transitionToOpen(issue, headSha));
    }
    for (const issue of matchResult.resolvedIssues) {
      updatedIssues.set(issue.id, transitionToFixed(issue, headSha));
    }
    for (const issue of matchResult.reintroducedIssues) {
      updatedIssues.set(issue.id, transitionToReintroduced(issue, headSha));
    }
    for (const issue of matchResult.newIssues) {
      updatedIssues.set(issue.id, transitionToNew(issue, headSha));
    }
    // Record review outcomes in D1 memory (best-effort)
    if (this.env.DB) {
      try {
        await recordReviewFindings(this.env.DB, {
          owner,
          repo,
          prNumber,
          headSha,
          findings: currentIssues.map(ci => ({
            fingerprint: ci.fingerprint,
            logicalKey: ci.logicalKey,
            ruleId: ci.payload.ruleId,
            filePath: ci.payload.filePath,
            line: ci.payload.line,
            severity: ci.payload.severity,
            body: ci.payload.body,
            status: ci.payload.status,
            githubCommentId: ci.payload.githubCommentId,
          })),
        });
      } catch (error) {
        console.warn('[memory] Failed to record review outcomes:', error);
      }
    }

    // Resolve fixed comments (if enabled)
    const postFixedReplies = this.env.DONMERGE_POST_FIXED_REPLIES === 'true';
    if (postFixedReplies && matchResult.resolvedIssues.length > 0) {
      await resolveFixedComments(
        owner,
        repo,
        prNumber,
        matchResult.resolvedIssues.filter((issue) => issue.githubCommentId).map((issue) => ({
          id: issue.githubCommentId!,
          path: issue.filePath,
          line: issue.line,
          body: issue.body,
          resolved: issue.status === 'fixed',
        })),
        githubToken
      );
    }

    // Filter comments + blocking approval
    const filteredResult = withBlockingApproval({
      ...result,
      lineComments: filterCommentsByMatch(
        result.lineComments,
        currentIssues.map((ci) => ci.fingerprint),
        currentIssues.map((ci) => ci.logicalKey),
        matchResult.newIssues.map((i) => i.fingerprint),
        matchResult.reintroducedIssues.map((i) => i.logicalKey)
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

    // Publish review (validates anchors against threaded patches; returns dropped comments)
    const droppedComments = await publishReview(
      owner,
      repo,
      prNumber,
      headSha,
      gated.review,
      githubToken,
      activePreviousComments,
      preparedFiles.filePatches,
      prData.baseBranch,
      runId,
      {},
      runId ? () => (processorStub as any).reservePublication(runId) : undefined
    );

    // Persist after the review POST succeeds or its marker is reconciled. A
    // retry after a pre-POST failure must still see these findings as new.
    await (processorStub as any).saveTrackedIssuesRpc(Array.from(updatedIssues.values()), runId);

    // Attach comment IDs to new issues
    if (matchResult.newIssues.length > 0) {
      const comments = await fetchReviewComments(owner, repo, prNumber, githubToken);
      const updatedNewIssues = matchResult.newIssues.map((issue) => {
        if (issue.githubCommentId) return issue;
        const matching = comments.find(
          (comment) => comment.path === issue.filePath && comment.body.includes(issue.fingerprint)
        );
        return matching ? { ...issue, githubCommentId: matching.id } : issue;
      });

      // Merge back into stored issues
      const storedAfterSave = await (processorStub as any).loadTrackedIssuesRpc();
      const updatedById = new Map(updatedNewIssues.map((issue) => [issue.id, issue]));
      const merged = storedAfterSave.map((issue: TrackedIssue) => updatedById.get(issue.id) ?? issue);
      await (processorStub as any).saveTrackedIssuesRpc(merged, runId);
    }

    // Complete check run (surfaces dropped comments when present; honest
    // conclusion about scope — neutral, not green, for partial reviews)
    await completeCheckRun(
      owner,
      repo,
      checkRunId,
      gated.review,
      githubToken,
      droppedComments,
      preparedFiles.coverage
    );

    // Update PR description
    await updatePRDescription(owner, repo, prNumber, gated.review, githubToken, preparedFiles.coverage);

    // Update DO status
    await (processorStub as any).updateFromWorkflow({
      state: 'complete',
      completedAt: new Date().toISOString(),
      result: gated.review,
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
