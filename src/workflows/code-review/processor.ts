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

import type { WorkerEnv, ReviewResult, PreviousComment, PRSummary, RepoContext as RepoContextType } from './types';
import {
  githubFetch,
  createCheckRun,
  addCommentReaction,
  fetchPreviousDonMergeComments,
  fetchRepoContext,
  resolveFixedComments,
  publishReview,
  completeCheckRun,
  failCheckRun,
  updatePRDescription,
} from './github-api';
import { resolveGitHubToken } from './github-auth';
import { safeJsonParse, parseModelConfig, formatPromptError, getRepoConfig } from './utils';
import { buildReviewPrompt } from './prompts';

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
    return this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
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
      await this.failReview(context, `Review exceeded maximum attempts (${status.attempts})`);
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
        await this.failReview(context, message);
      }
    }
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
    const diffText = filesToReview
      .map((file) => `FILE: ${file.filename}\n${file.patch ?? '[no patch available]'}\n`)
      .join('\n');

    // Fetch repo context (standards, configs, docs)
    const repoContext = await fetchRepoContext(owner, repo, githubToken);

    // Run LLM review
    const result = await this.runLlmReview(
      { owner, repo, prNumber, retrigger, instruction, repoContext },
      previousComments,
      diffText,
      githubToken
    );

    // Resolve fixed comments
    if (result.resolvedComments && result.resolvedComments.length > 0) {
      await resolveFixedComments(owner, repo, result.resolvedComments, githubToken);
    }

    // Post review
    await publishReview(owner, repo, prNumber, headSha!, result, githubToken, previousComments);

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
    githubToken: string
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
    const prompt = buildReviewPrompt({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      retrigger: input.retrigger,
      instruction: input.instruction,
      previousComments,
      diffText,
      repoContext: input.repoContext,
    });

    const promptErrorHint =
      'Your previous response was invalid. Return ONLY valid JSON matching the schema. ' +
      'Ensure `summary` is present and 1-2 sentences. Ensure `prSummary` includes overview, keyChanges (non-empty), codeQuality, testingNotes, riskAssessment. ' +
      'If `criticalIssues` is non-empty, you MUST include `lineComments` for each issue.';

    let response: string;
    let parsed: ReviewResult;
    try {
      response = await flue.client.prompt(prompt, { model, result: v.string() });
    } catch (error) {
      throw new Error(formatPromptError(error, `${model.providerID}/${model.modelID}`));
    }

    parsed = safeJsonParse<ReviewResult>(response);
    const validation = this.validateReviewResult(parsed);
    if (validation.valid) {
      return this.normalizeReviewResult(parsed, previousComments);
    }

    const retryPrompt = `${prompt}\n\n${promptErrorHint}\nReason: ${validation.reason}`;
    try {
      response = await flue.client.prompt(retryPrompt, { model, result: v.string() });
    } catch (error) {
      throw new Error(formatPromptError(error, `${model.providerID}/${model.modelID}`));
    }

    parsed = safeJsonParse<ReviewResult>(response);
    const retryValidation = this.validateReviewResult(parsed);
    if (retryValidation.valid) {
      return this.normalizeReviewResult(parsed, previousComments);
    }

    throw new Error(`Invalid review output after retry: ${retryValidation.reason}`);
  }

  /**
   * Normalize and validate the review result
   */
  private normalizeReviewResult(
    result: ReviewResult,
    previousComments?: PreviousComment[]
  ): ReviewResult {
    let resolvedComments: number[] = [];
    if (result.resolvedComments && previousComments && previousComments.length > 0) {
      const validIds = new Set(previousComments.map((c) => c.id));
      resolvedComments = result.resolvedComments.filter((id) => validIds.has(id));
    }

    const lineComments = Array.isArray(result.lineComments)
      ? result.lineComments.map((comment) => ({
          ...comment,
          issueKey: deriveIssueKey(comment),
        }))
      : [];
    const criticalIssues = Array.isArray(result.criticalIssues) ? result.criticalIssues : [];

    const hasLineComments = lineComments.length > 0;
    const hasCriticalIssues = criticalIssues.length > 0;
    const approved = !hasLineComments && !hasCriticalIssues;

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
      lineComments,
      criticalIssues,
      suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
      resolvedComments,
      fileSummaries: Array.isArray(result.fileSummaries) ? result.fileSummaries : [],
    };
  }

  /**
   * Validate required fields from LLM output.
   */
  private validateReviewResult(result: ReviewResult): { valid: boolean; reason?: string } {
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

    const criticalIssues = Array.isArray(result.criticalIssues) ? result.criticalIssues : [];
    const lineComments = Array.isArray(result.lineComments) ? result.lineComments : [];

    for (const comment of lineComments) {
      if (!deriveIssueKey(comment)) {
        return { valid: false, reason: 'lineComment missing issueKey' };
      }
    }

    if (criticalIssues.length > 0 && lineComments.length === 0) {
      return { valid: false, reason: 'criticalIssues present but lineComments empty' };
    }

    return { valid: true };
  }

  /**
   * Fail the review and update the check run if it exists
   */
  private async failReview(context: ReviewContext, error: string): Promise<void> {
    if (context.checkRunId && context.githubToken) {
      try {
        await failCheckRun(context.owner, context.repo, context.checkRunId, error, context.githubToken);
      } catch (e) {
        console.error('Failed to update check run on failure', { error: e });
      }
    }

    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (status) {
      status.state = 'failed';
      status.error = error;
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

function deriveIssueKey(comment: { issueKey?: string; body: string }): string | undefined {
  const normalizedProvided = normalizeIssueKey(comment.issueKey);
  const derivedFromBody = normalizeIssueKey(extractIssueSentence(comment.body));

  return derivedFromBody ?? normalizedProvided;
}

function extractIssueSentence(body: string): string | undefined {
  const issueMatch = body.match(/\*\*Issue:\*\*\s*([^\n]+)/i);
  if (!issueMatch?.[1]) {
    return undefined;
  }

  return issueMatch[1]
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(compadre|che|ojo|mira)\b[:,.!]?/gi, ' ')
    .replace(/\b(this|that|the|a|an|so|now|which|when|on|in|at|to|for|of|and|or|it|is|are)\b/gi, ' ')
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIssueKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((segment) => segment.length > 1)
    .slice(0, 8)
    .join('-');

  return normalized || undefined;
}

/**
 * Get a ReviewProcessor stub for a specific PR
 */
export function getReviewProcessor(
  namespace: DurableObjectNamespace,
  owner: string,
  repo: string,
  prNumber: number
): DurableObjectStub {
  const id = namespace.idFromName(`${owner}/${repo}/${prNumber}`);
  return namespace.get(id);
}
