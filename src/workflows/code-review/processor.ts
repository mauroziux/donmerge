/**
 * ReviewProcessor Durable Object
 *
 * Handles long-running code reviews using alarms for reliable execution.
 * DO alarms don't have the same timeout pressure as waitUntil() because
 * there's no client waiting for a response.
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';
import * as v from 'valibot';

import type {
  WorkerEnv,
  ReviewResult,
  PreviousComment,
  PRSummary,
  RepoContext as RepoContextType,
  ReviewComment,
  TrackedIssue,
  DonmergeResolved,
} from './types';
import {
  githubFetch,
  createCheckRun,
  addCommentReaction,
  fetchPreviousDonMergeComments,
  fetchReviewComments,
  fetchRepoContext,
  fetchRepoFile,
  resolveFixedComments,
  publishReview,
  completeCheckRun,
  failCheckRun,
  updatePRDescription,
} from './github-api';
import { resolveGitHubToken } from './github-auth';
import { deriveIssueKey } from './issue-key';
import {
  buildAnchorKey,
  buildLogicalKey,
  computeFingerprint,
  computeSnippetHash,
  normalizeEntityType,
  normalizeRuleId,
  normalizeSymbolName,
} from './issue-identity';
import { transitionToFixed, transitionToNew, transitionToOpen, transitionToReintroduced } from './issue-lifecycle';
import { matchCurrentFindingsToStored, type CurrentIssue } from './issue-matcher';
import { loadTrackedIssues, saveTrackedIssues } from './issue-store';
import { safeJsonParse, parseModelConfig, formatPromptError, getRepoConfig, extractRawFlueResponse, extractJsonFromResponse, classifyError } from './utils';
import { ErrorCode, type ErrorCode as ErrorCodeType } from './error-codes';
import { buildReviewPrompt } from './prompts';
import {
  fetchDonmergeConfig,
  shouldExcludeFile,
  resolveDonmergeSkills,
} from './donmerge';
import {
  validateReviewResult,
  normalizeReviewResult,
  filterCommentsByMatch,
  syncTrackedIssuesFromComments,
} from './processor-utils';

// State keys
const STATE_KEYS = {
  context: 'reviewContext',
  status: 'reviewStatus',
};

interface ReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  installationId?: number;
  instruction?: string;
  focusFiles?: string[];
  checkRunId?: number; // Created by DO if not provided
  headSha?: string; // Fetched by DO if not provided
  githubToken?: string; // Resolved by DO if not provided
}

interface ReviewStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface EnvWithBindings extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
}

export class ReviewProcessor extends DurableObject<EnvWithBindings> {
  private state: DurableObjectState;
  private env: EnvWithBindings;

  constructor(state: DurableObjectState, env: EnvWithBindings) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  /**
   * Start a new review. Called from the webhook handler.
   */
  async startReview(context: ReviewContext): Promise<void> {
    // Check if there's already a review in progress
    const existingStatus = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (existingStatus?.state === 'running') {
      console.log('Review already in progress, skipping');
      return;
    }

    // Store the context
    await this.state.storage.put(STATE_KEYS.context, context);

    // Initialize status
    const status: ReviewStatus = {
      state: 'pending',
      attempts: 0,
      startedAt: new Date().toISOString(),
    };
    await this.state.storage.put(STATE_KEYS.status, status);

    // Schedule alarm to run immediately
    await this.state.storage.setAlarm(Date.now());
  }

  /**
   * Get current review status
   */
  async getStatus(): Promise<ReviewStatus | null> {
    return (await this.state.storage.get<ReviewStatus>(STATE_KEYS.status)) ?? null;
  }

  /**
   * Alarm handler - runs the review in a fresh execution context.
   * DO alarms have more relaxed timeout constraints than waitUntil().
   */
  async alarm(): Promise<void> {
    const context = await this.state.storage.get<ReviewContext>(STATE_KEYS.context);
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);

    if (!context || !status) {
      console.error('ReviewProcessor: No context or status found');
      return;
    }

    // Skip if already complete or failed
    if (status.state === 'complete' || status.state === 'failed') {
      console.log('Review already terminal', { state: status.state });
      return;
    }

    // Update status
    status.state = 'running';
    status.attempts += 1;
    await this.state.storage.put(STATE_KEYS.status, status);

    console.log('ReviewProcessor alarm fired', {
      attempt: status.attempts,
      prNumber: context.prNumber,
    });

    // Safety: prevent infinite loops
    if (status.attempts > 5) {
      await this.failReview(context, ErrorCode.MAX_ATTEMPTS, `Review exceeded maximum attempts (${status.attempts})`);
      return;
    }

    try {
      await this.runReview(context, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error('ReviewProcessor error', { attempt: status.attempts, error: message });

      // Check if we should retry
      if (this.shouldRetry(error) && status.attempts < 5) {
        status.error = message;
        await this.state.storage.put(STATE_KEYS.status, status);
        // Retry in 10 seconds
        await this.state.storage.setAlarm(Date.now() + 10000);
      } else {
        const { code, detail } = classifyError(error);
        await this.failReview(context, code, detail);
      }
    }
  }

  /**
   * Build CurrentIssue array from review line comments.
   */
  private async buildCurrentIssues(
    context: ReviewContext,
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

  /**
   * Run the full review process
   */
  private async runReview(context: ReviewContext, status: ReviewStatus): Promise<void> {
    const { owner, repo, prNumber, retrigger, commentId, commentType, instruction, focusFiles } = context;

    // Resolve token if not provided
    let githubToken = context.githubToken;
    if (!githubToken) {
      githubToken = await resolveGitHubToken(this.env, context.installationId);
      // Cache it for retries
      context.githubToken = githubToken;
      await this.state.storage.put(STATE_KEYS.context, context);
    }

    // Fetch PR info if headSha not provided
    let headSha = context.headSha;
    let checkRunId = context.checkRunId;
    
    if (!headSha) {
      const pr = await githubFetch<{ base: { ref: string }; head: { sha: string } }>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        githubToken
      );
      
      // Check base branch using per-repo config
      const repoConfig = getRepoConfig(owner, repo, this.env.REPO_CONFIGS);
      
      // Only filter by base branch if the repo config specifies one
      if (repoConfig?.baseBranch && pr.base.ref !== repoConfig.baseBranch) {
        console.log('PR skipped - wrong base branch', {
          expected: repoConfig.baseBranch,
          actual: pr.base.ref,
          repo: `${owner}/${repo}`,
        });
        status.state = 'complete';
        status.completedAt = new Date().toISOString();
        await this.state.storage.put(STATE_KEYS.status, status);
        return;
      }
      
      headSha = pr.head.sha;
      context.headSha = headSha;
    }

    // Create check run if not provided
    if (!checkRunId) {
      const checkRun = await createCheckRun(owner, repo, headSha!, githubToken);
      checkRunId = checkRun.id;
      context.checkRunId = checkRunId;
    }

    // Cache updated context
    await this.state.storage.put(STATE_KEYS.context, context);

    // Fetch .donmerge config (best-effort, never fails the review)
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
        // Don't resolve skills yet — wait until after repo context fetch
        donmergeResolved = { config: donmergeConfig, skillsContent: new Map(), skillsErrors: new Map() };
      }
    } catch (error) {
      console.warn('[donmerge] Failed to fetch config, continuing without it:', error);
    }

    // Add eyes reaction
    if (commentId && commentType) {
      await addCommentReaction(owner, repo, commentId, commentType, githubToken);
    }

    // Fetch previous comments if retrigger
    let previousComments: PreviousComment[] = [];
    if (retrigger) {
      previousComments = await fetchPreviousDonMergeComments(owner, repo, prNumber, githubToken);
      console.log('Found previous comments', { count: previousComments.length });
    }
    const activePreviousComments = previousComments.filter((comment) => !comment.resolved);

    // Fetch PR files
    const filesResponse = await githubFetch<Array<{ filename: string; patch?: string }>>(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
      githubToken
    );

    const maxFiles = Number.parseInt(this.env.MAX_REVIEW_FILES ?? '50', 10);
    let filesToReview = filesResponse.slice(0, maxFiles);
    if (focusFiles && focusFiles.length > 0) {
      const normalizedFocus = focusFiles.map((file) => file.trim()).filter(Boolean);
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

    // Fetch repo context (standards, configs, docs)
    const repoContext = await fetchRepoContext(owner, repo, githubToken);

    // Resolve .donmerge skills (fetch skill file contents, best-effort)
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

    // Run LLM review
    const result = await this.runLlmReview(
      { owner, repo, prNumber, retrigger, instruction, repoContext },
      activePreviousComments,
      diffText,
      githubToken,
      donmergeResolved
    );

    let storedIssues: TrackedIssue[] = [];
    let currentIssues: CurrentIssue[] = [];
    let matchResult = null as ReturnType<typeof matchCurrentFindingsToStored> | null;
    if (headSha) {
      storedIssues = await loadTrackedIssues(this.state.storage);
      if (activePreviousComments.length > 0 && storedIssues.length > 0) {
        storedIssues = syncTrackedIssuesFromComments(storedIssues, activePreviousComments);
        await saveTrackedIssues(this.state.storage, storedIssues);
      }
      currentIssues = await this.buildCurrentIssues(context, headSha, result.lineComments);
      matchResult = matchCurrentFindingsToStored(currentIssues, storedIssues);
      await this.updateTrackedIssuesWithMatch(headSha, storedIssues, currentIssues, matchResult);
    }

    if (matchResult && matchResult.resolvedIssues.length > 0) {
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

    // Post review
    const filteredResult = matchResult
      ? {
          ...result,
          lineComments: filterCommentsByMatch(
            result.lineComments,
            currentIssues.map((ci) => ci.fingerprint),
            currentIssues.map((ci) => ci.logicalKey),
            matchResult.newIssues.map((i) => i.fingerprint),
            matchResult.reintroducedIssues.map((i) => i.logicalKey)
          ),
        }
      : result;

    await publishReview(owner, repo, prNumber, headSha!, filteredResult, githubToken, activePreviousComments);

    if (matchResult && matchResult.newIssues.length > 0) {
      const updatedIssues = await this.attachCommentIds(
        owner,
        repo,
        prNumber,
        githubToken,
        matchResult.newIssues
      );
      await this.updateStoredIssues(updatedIssues);
    }

    // Complete check run
    await completeCheckRun(owner, repo, checkRunId!, result, githubToken);

    // Update PR description
    await updatePRDescription(owner, repo, prNumber, result, githubToken);

    // Mark complete
    status.state = 'complete';
    status.completedAt = new Date().toISOString();
    await this.state.storage.put(STATE_KEYS.status, status);

    console.log('Review completed successfully', {
      owner,
      repo,
      prNumber,
      approved: result.approved,
      attempts: status.attempts,
    });
  }

  /**
   * Run the LLM review using Flue
   */
  private async runLlmReview(
    input: {
      owner: string;
      repo: string;
      prNumber: number;
      retrigger: boolean;
      instruction?: string;
      repoContext: RepoContextType;
    },
    previousComments: PreviousComment[],
    diffText: string,
    githubToken: string,
    donmergeResolved?: DonmergeResolved
  ): Promise<ReviewResult> {
    const sessionId = `review-${input.owner}-${input.repo}-${input.prNumber}-${Date.now()}`;
    const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: '30m' });
    const flue = new FlueRuntime({ sandbox, sessionId, workdir: '/home/user' });

    await sandbox.setEnvVars({
      OPENAI_API_KEY: this.env.OPENAI_API_KEY,
      GITHUB_TOKEN: githubToken,
    });
    await flue.setup();

    const model = parseModelConfig(this.env.CODEX_MODEL);
    const prompt = buildReviewPrompt(
      {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        retrigger: input.retrigger,
        instruction: input.instruction,
        previousComments,
        diffText,
        repoContext: input.repoContext,
      },
      { donmergeResolved }
    );

    const promptErrorHint =
      'Your previous response was invalid. Produce valid JSON matching the schema. ' +
      'Ensure `summary` is present and 1-2 sentences. Ensure `prSummary` includes overview, keyChanges (non-empty), codeQuality, testingNotes, riskAssessment. ' +
      'If `criticalIssues` is non-empty, you MUST include `lineComments` for each issue.';

    const severityOverrides = donmergeResolved?.config.severity;

    let response: string;
    let parsed: ReviewResult;
    try {
      response = await flue.client.prompt(prompt, { model, result: v.string() });
    } catch (error) {
      const rawResponse = extractRawFlueResponse(error);
      if (rawResponse) {
        try {
          const jsonText = extractJsonFromResponse(rawResponse);
          parsed = safeJsonParse<ReviewResult>(jsonText);
          const validation = validateReviewResult(parsed);
          if (validation.valid) {
            return normalizeReviewResult(parsed, previousComments, severityOverrides);
          }
          response = rawResponse;
        } catch {
          // Raw response could not be parsed, fall through to throw
        }
      }
      if (!response) {
        throw new Error(formatPromptError(error, `${model.providerID}/${model.modelID}`));
      }
    }

    parsed = safeJsonParse<ReviewResult>(response);
    const validation = validateReviewResult(parsed);
    if (validation.valid) {
      return normalizeReviewResult(parsed, previousComments, severityOverrides);
    }

    const retryPrompt = `${prompt}\n\n${promptErrorHint}\nReason: ${validation.reason}`;
    try {
      response = await flue.client.prompt(retryPrompt, { model, result: v.string() });
    } catch (error) {
      const rawResponse = extractRawFlueResponse(error);
      if (rawResponse) {
        try {
          const jsonText = extractJsonFromResponse(rawResponse);
          parsed = safeJsonParse<ReviewResult>(jsonText);
          const retryValidation = validateReviewResult(parsed);
          if (retryValidation.valid) {
            return normalizeReviewResult(parsed, previousComments, severityOverrides);
          }
          response = rawResponse;
        } catch {
          // Raw response could not be parsed, fall through to throw
        }
      }
      if (!response) {
        throw new Error(formatPromptError(error, `${model.providerID}/${model.modelID}`));
      }
    }

    parsed = safeJsonParse<ReviewResult>(response);
    const retryValidation = validateReviewResult(parsed);
    if (retryValidation.valid) {
      return normalizeReviewResult(parsed, previousComments, severityOverrides);
    }

    throw new Error(`Invalid review output after retry: ${retryValidation.reason}`);
  }

  /**
   * Build issues from review comments.
   */
  private async updateTrackedIssuesWithMatch(
    headSha: string,
    storedIssues: TrackedIssue[],
    currentIssues: CurrentIssue[],
    match: ReturnType<typeof matchCurrentFindingsToStored>
  ): Promise<void> {
    const updatedIssues = new Map<string, TrackedIssue>();

    for (const issue of storedIssues) {
      updatedIssues.set(issue.id, issue);
    }

    for (const issue of match.persistingIssues) {
      updatedIssues.set(issue.id, transitionToOpen(issue, headSha));
    }

    for (const issue of match.resolvedIssues) {
      updatedIssues.set(issue.id, transitionToFixed(issue, headSha));
    }

    for (const issue of match.reintroducedIssues) {
      updatedIssues.set(issue.id, transitionToReintroduced(issue, headSha));
    }

    for (const issue of match.newIssues) {
      updatedIssues.set(issue.id, transitionToNew(issue, headSha));
    }

    await saveTrackedIssues(this.state.storage, Array.from(updatedIssues.values()));
  }

  /**
   * Attach GitHub comment IDs to new issues.
   */
  private async attachCommentIds(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
    issues: TrackedIssue[]
  ): Promise<TrackedIssue[]> {
    if (issues.length === 0) {
      return issues;
    }

    const comments = await fetchReviewComments(owner, repo, prNumber, token);
    return issues.map((issue) => {
      if (issue.githubCommentId) {
        return issue;
      }

      const matching = comments.find((comment) => {
        if (comment.path !== issue.filePath) {
          return false;
        }
        return comment.body.includes(issue.fingerprint);
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

  private async updateStoredIssues(updatedIssues: TrackedIssue[]): Promise<void> {
    if (updatedIssues.length === 0) {
      return;
    }

    const storedIssues = await loadTrackedIssues(this.state.storage);
    const updatedById = new Map(updatedIssues.map((issue) => [issue.id, issue]));
    const merged = storedIssues.map((issue) => updatedById.get(issue.id) ?? issue);
    await saveTrackedIssues(this.state.storage, merged);
  }

  /**
   * Build issues from review comments.
   */
  private async failReview(context: ReviewContext, code: ErrorCodeType, detail: string): Promise<void> {
    if (context.checkRunId && context.githubToken) {
      try {
        await failCheckRun(context.owner, context.repo, context.checkRunId, code, detail, context.githubToken);
      } catch (e) {
        console.error('Failed to update check run on failure', { error: e });
      }
    }

    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (status) {
      status.state = 'failed';
      status.error = `[${code}] ${detail}`;
      status.completedAt = new Date().toISOString();
      await this.state.storage.put(STATE_KEYS.status, status);
    }
  }

  /**
   * Check if we should retry after an error
   */
  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    // Don't retry on auth errors or invalid requests
    if (
      message.includes('invalid') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('not found') ||
      message.includes('credentials') ||
      message.includes('insufficient_quota') ||
      message.includes('quota') ||
      message.includes('billing') ||
      message.includes('payment')
    ) {
      return false;
    }
    // Retry on network/timeout errors
    return true;
  }
}


/**
 * Get a ReviewProcessor stub for a specific PR
 */
export function getReviewProcessor(
  namespace: DurableObjectNamespace,
  owner: string,
  repo: string,
  prNumber: number
): DurableObjectStub<ReviewProcessor> {
  const id = namespace.idFromName(`${owner}/${repo}/${prNumber}`);
  return namespace.get(id) as DurableObjectStub<ReviewProcessor>;
}
