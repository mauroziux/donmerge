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
  resolveFixedComments,
  publishReview,
  completeCheckRun,
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
} from './processor-utils';
import { recordReviewFindings } from './feedback-handler';
import { buildMemoryContext, getPatternWeights } from './memory-store';
import { destroySandbox, SANDBOX_SLEEP_AFTER } from '../../lib/sandbox-lifecycle';
import { AllModelsFailedError, runReviewModels } from './review-model-runner';

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
}

// ── Intermediate data passed between steps ───────────────────────────────────

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
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  instruction?: string;
  focusFiles?: string[];
  model?: string;
  maxFiles?: number;
}

interface PreparedFiles {
  prData: PrData;
  diffText: string;
  repoContext: RepoContextType;
  donmergeResolved?: DonmergeResolved;
  activePreviousComments: PreviousComment[];
  /** PR file patches captured in step 2, reused by step 4 for anchor validation. */
  filePatches: FilePatch[];
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

    // Mark review as running
    await (processorStub as any).updateFromWorkflow({ state: 'running' });

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
        timeout: '20 minutes',
      }, async () => {
        return this.runLlmReview(preparedFiles);
      });

      // Step 4: Publish review
      await step.do('publish-review', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        timeout: '3 minutes',
      }, async () => {
        return this.publishReview(llmResult, processorStub);
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
          await failCheckRun(
            prData.owner,
            prData.repo,
            prData.checkRunId,
            code,
            detail,
            prData.githubToken
          );
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
      base: { ref: string };
      head: { sha: string };
      title?: string;
      body?: string | null;
    }>(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, githubToken);

    // Check base branch
    const repoConfig = getRepoConfig(owner, repo, this.env.REPO_CONFIGS);
    if (repoConfig?.baseBranch && pr.base.ref !== repoConfig.baseBranch) {
      console.log('PR skipped - wrong base branch', {
        expected: repoConfig.baseBranch,
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

    // Fetch PR files
    const filesResponse = await githubFetch<Array<{ filename: string; patch?: string }>>(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
      githubToken
    );

    const maxFiles = prData.maxFiles ?? Number.parseInt(this.env.MAX_REVIEW_FILES ?? '50', 10);
    let filesToReview = filesResponse.slice(0, maxFiles);

    // Apply focus files filter
    if (prData.focusFiles && prData.focusFiles.length > 0) {
      const normalizedFocus = prData.focusFiles.map((file) => file.trim()).filter(Boolean);
      const matched = filesToReview.filter((file) =>
        normalizedFocus.some(
          (focus) => file.filename === focus || file.filename.endsWith(`/${focus}`)
        )
      );
      if (matched.length > 0) {
        filesToReview = matched;
      } else {
        console.log('No focus file matches found, falling back to full diff', {
          focusFiles: normalizedFocus,
          fileCount: filesToReview.length,
        });
      }
    }

    // Apply .donmerge exclude/include filtering (best-effort)
    // Note: donmerge config was fetched in step 1, but we don't pass it through the serializable
    // boundary. Re-fetch here if needed. Actually, let's re-fetch it here.
    let donmergeResolved: DonmergeResolved | undefined;
    try {
      const donmergeConfig = await fetchDonmergeConfig(owner, repo, githubToken, fetchRepoFile);
      if (donmergeConfig) {
        donmergeResolved = { config: donmergeConfig, skillsContent: new Map(), skillsErrors: new Map() };
      }
    } catch {
      // Best-effort
    }

    if (donmergeResolved) {
      try {
        const excludePatterns = donmergeResolved.config.exclude ?? [];
        const includePatterns = donmergeResolved.config.include ?? [];
        if (excludePatterns.length > 0) {
          const beforeCount = filesToReview.length;
          filesToReview = filesToReview.filter(
            (file) => !shouldExcludeFile(file.filename, excludePatterns, includePatterns)
          );
          if (filesToReview.length < beforeCount) {
            console.log('[donmerge] Excluded files', {
              before: beforeCount,
              after: filesToReview.length,
            });
          }
        }
      } catch (error) {
        console.warn('[donmerge] File filtering failed, continuing:', error);
      }
    }

    const diffText = filesToReview
      .map((file) => `FILE: ${file.filename}\n${file.patch ?? '[no patch available]'}\n`)
      .join('\n');

    // Fetch repo context
    const repoContext = await fetchRepoContext(owner, repo, githubToken);

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
      // without re-fetching listFiles. filesToReview is the filtered set the LLM
      // actually saw, so it is the correct anchor scope.
      filePatches: filesToReview.map((file) => ({
        filename: file.filename,
        patch: file.patch,
      })),
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
        { donmergeResolved, memoryContext }
      );

      const promptErrorHint =
        'Your previous response was invalid. Produce valid JSON matching the schema. ' +
        'Ensure `summary` is present and 1-2 sentences. Ensure `prSummary` includes overview, keyChanges (non-empty), codeQuality, testingNotes, riskAssessment. ' +
        'Only use `lineComments` for concrete findings anchored to lines in the diff.';

      const result = await runReviewModels({
        flue,
        prompt,
        promptErrorHint,
        models,
        activePreviousComments,
        severityOverrides: donmergeResolved?.config.severity,
        patternWeights,
      });
      return { preparedFiles, result };
    } catch (error) {
      if (error instanceof AllModelsFailedError) {
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
    processorStub: DurableObjectStub
  ): Promise<void> {
    const { preparedFiles, result } = llmResult;
    const { prData, activePreviousComments } = preparedFiles;
    const { owner, repo, prNumber, headSha, checkRunId, githubToken } = prData;

    // Skip if checkRunId is 0 (base branch mismatch)
    if (checkRunId === 0) {
      await (processorStub as any).updateFromWorkflow({
        state: 'complete',
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // Load tracked issues from DO via RPC
    let storedIssues: TrackedIssue[] = await (processorStub as any).loadTrackedIssuesRpc();
    if (activePreviousComments.length > 0 && storedIssues.length > 0) {
      storedIssues = syncTrackedIssuesFromComments(storedIssues, activePreviousComments);
      await (processorStub as any).saveTrackedIssuesRpc(storedIssues);
    }

    // Build current issues + match
    const context: IssueBuilderContext = { repo, prNumber };
    const currentIssues = await buildCurrentIssues(context, headSha, result.lineComments);
    const matchResult = matchCurrentFindingsToStored(currentIssues, storedIssues);

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
    await (processorStub as any).saveTrackedIssuesRpc(Array.from(updatedIssues.values()));

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
      prData.baseBranch
    );

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
      await (processorStub as any).saveTrackedIssuesRpc(merged);
    }

    // Complete check run (surfaces dropped comments when present)
    await completeCheckRun(owner, repo, checkRunId, gated.review, githubToken, droppedComments);

    // Update PR description
    await updatePRDescription(owner, repo, prNumber, gated.review, githubToken);

    // Update DO status
    await (processorStub as any).updateFromWorkflow({
      state: 'complete',
      completedAt: new Date().toISOString(),
      result: gated.review,
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
