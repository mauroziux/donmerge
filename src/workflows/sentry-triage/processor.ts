/**
 * SentryTriageProcessor Durable Object
 *
 * Handles long-running Sentry triage analysis using alarms for reliable execution.
 * Mirrors the ReviewProcessor pattern: alarm-based lifecycle, retry logic, token redaction.
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';
import * as v from 'valibot';

import type {
  SentryTriageEnv,
  SentryTriageContext,
  SentryTriageStatus,
  SentryTriageResult,
  SentryIssueData,
  SentryTriageOutput,
} from './types';
import { fetchFullSentryIssue } from './sentry-api';
import { fetchRepoCodeForTriage } from './repo-fetcher';
import { buildTriagePrompt } from './prompts';
import { runAutoFix } from './auto-fix';
import { runCreateIssue } from './trackers';
import { parseModelConfig, safeJsonParse } from './utils';

// State keys
const STATE_KEYS = {
  context: 'triageContext',
  status: 'triageStatus',
} as const;

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10000;

interface EnvWithBindings extends SentryTriageEnv {
  SentryTriageProcessor: DurableObjectNamespace;
}

export class SentryTriageProcessor extends DurableObject<EnvWithBindings> {
  private state: DurableObjectState;
  private env: EnvWithBindings;

  constructor(state: DurableObjectState, env: EnvWithBindings) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  /**
   * Start a new Sentry triage. Called from the API route handler.
   */
  async startTriage(context: SentryTriageContext): Promise<void> {
    // Check if there's already a triage in progress
    const existingStatus = await this.state.storage.get<SentryTriageStatus>(STATE_KEYS.status);
    if (existingStatus?.state === 'running') {
      console.log('Sentry triage already in progress, skipping');
      return;
    }

    // Store the context
    await this.state.storage.put(STATE_KEYS.context, context);

    // Initialize status
    const status: SentryTriageStatus = {
      state: 'pending',
      attempts: 0,
      startedAt: new Date().toISOString(),
    };
    await this.state.storage.put(STATE_KEYS.status, status);

    // Schedule alarm to run immediately
    await this.state.storage.setAlarm(Date.now());
  }

  /**
   * Get current triage status.
   * If callerKeyHash is provided and an initiatorKeyHash was stored,
   * they must match — otherwise throws to prevent unauthorized access.
   */
  async getStatus(callerKeyHash?: string): Promise<SentryTriageStatus | null> {
    if (callerKeyHash) {
      const context = await this.state.storage.get<SentryTriageContext>(STATE_KEYS.context);
      if (context?.initiatorKeyHash && context.initiatorKeyHash !== callerKeyHash) {
        throw new Error('not found: caller key hash does not match initiator');
      }
    }
    return (await this.state.storage.get<SentryTriageStatus>(STATE_KEYS.status)) ?? null;
  }

  /**
   * Alarm handler - runs the triage in a fresh execution context.
   */
  async alarm(): Promise<void> {
    const context = await this.state.storage.get<SentryTriageContext>(STATE_KEYS.context);
    const status = await this.state.storage.get<SentryTriageStatus>(STATE_KEYS.status);

    if (!context || !status) {
      console.error('SentryTriageProcessor: No context or status found');
      return;
    }

    // Skip if already complete or failed
    if (status.state === 'complete' || status.state === 'failed') {
      console.log('Sentry triage already terminal', { state: status.state });
      return;
    }

    // Update status
    status.state = 'running';
    status.attempts += 1;
    await this.state.storage.put(STATE_KEYS.status, status);

    console.log('SentryTriageProcessor alarm fired', {
      attempt: status.attempts,
      jobId: context.jobId,
    });

    // Safety: prevent infinite loops
    if (status.attempts > MAX_ATTEMPTS) {
      await this.failTriage(context, `Triage exceeded maximum attempts (${status.attempts})`);
      return;
    }

    try {
      await this.runTriage(context, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error('SentryTriageProcessor error', { attempt: status.attempts, error: message });

      // Check if we should retry
      if (this.shouldRetry(error) && status.attempts < MAX_ATTEMPTS) {
        status.error = message;
        await this.state.storage.put(STATE_KEYS.status, status);
        // Retry in 10 seconds
        await this.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      } else {
        await this.failTriage(context, message);
      }
    }
  }

  /**
   * Run the full Sentry triage process.
   */
  private async runTriage(
    context: SentryTriageContext,
    status: SentryTriageStatus
  ): Promise<void> {
    // 1. Fetch Sentry issue data
    console.log('Fetching Sentry issue data', { url: context.sentryIssueUrl });
    const sentryData = await fetchFullSentryIssue(
      context.sentryIssueUrl,
      context.sentryAuthToken
    );

    // 2. Cache sentryData in context
    context.sentryData = sentryData;
    await this.state.storage.put(STATE_KEYS.context, context);

    // 3. Fetch repo code from stack trace paths
    const events = sentryData.events ?? [];
    console.log('Fetching repo code', { repo: context.repo, sha: context.sha, events: events.length });
    const sourceCode = await fetchRepoCodeForTriage(
      context.repo,
      context.sha,
      events,
      context.githubToken
    );

    // 4. Create shared sandbox+flue for both triage and auto-fix
    const sessionId = `sentry-triage-${context.jobId}`;
    const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: '30m' });
    const flue = new FlueRuntime({ sandbox, sessionId, workdir: '/home/user' });
    await sandbox.setEnvVars({ OPENAI_API_KEY: this.env.OPENAI_API_KEY });
    await flue.setup();

    // 5. Run LLM triage
    console.log('Running LLM triage', { sourceFiles: sourceCode.size });
    const output = await this.runLlmTriage(context, sentryData, sourceCode, flue);

    // 6. Build result
    const result: SentryTriageResult = {
      root_cause: output.root_cause,
      stack_trace_summary: output.stack_trace_summary,
      affected_files: output.affected_files,
      suggested_fix: output.suggested_fix,
      confidence: output.confidence,
      severity: output.severity,
      fix_pr_url: null,
      tracker_issue_url: null,
    };

    // 6b. Auto-fix (Phase C) — non-blocking (defaults to true)
    if (context.options?.auto_fix !== false) {
      try {
        const prUrl = await runAutoFix(
          {
            repo: context.repo,
            sha: context.sha,
            githubToken: context.githubToken,
            sentryIssueId: sentryData.id,
            sentryIssueUrl: context.sentryIssueUrl,
            sentryTitle: sentryData.title,
            triageOutput: output,
            sourceCode,
            flue,
          },
          this.env
        );
        if (prUrl) {
          result.fix_pr_url = prUrl;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        console.error('Auto-fix failed (triage still succeeds)', {
          jobId: context.jobId,
          error: msg,
        });
      }
    }

    // 5c. Tracker issue creation (Phase D) — always when tracker configured
    if (context.tracker) {
      const issueUrl = await runCreateIssue({
        repo: context.repo,
        sentryIssueUrl: context.sentryIssueUrl,
        sentryTitle: sentryData.title,
        triageOutput: output,
        tracker: context.tracker,
        fixPrUrl: result.fix_pr_url ?? null,
      });
      if (issueUrl) {
        result.tracker_issue_url = issueUrl;
      }
    }

    // 7. Mark complete
    status.state = 'complete';
    status.completedAt = new Date().toISOString();
    status.result = result;
    await this.state.storage.put(STATE_KEYS.status, status);

    // 8. Redact tokens
    await this.redactTokens();

    // Phase C: callback invocation — invoke context.callback here if present

    console.log('Sentry triage completed successfully', {
      jobId: context.jobId,
      severity: output.severity,
      confidence: output.confidence,
      affectedFiles: output.affected_files.length,
    });
  }

  /**
   * Run the LLM triage using Flue.
   */
  private async runLlmTriage(
    context: SentryTriageContext,
    sentryData: SentryIssueData,
    sourceCode: Map<string, string>,
    flue: FlueRuntime
  ): Promise<SentryTriageOutput> {
    const model = parseModelConfig(this.env.CODEX_MODEL);
    const prompt = buildTriagePrompt({
      sentryData,
      sourceCode,
      sha: context.sha,
      repo: context.repo,
      options: context.options,
    });

    const promptErrorHint =
      'Your previous response was invalid. Produce valid JSON matching the schema exactly. ' +
      'Ensure root_cause, stack_trace_summary, affected_files (array), suggested_fix, confidence (high|medium|low), ' +
      'and severity (critical|error|warning) are all present and correctly typed.';

    let response: string;
    try {
      response = await flue.client.prompt(prompt, { model, result: v.string() });
    } catch (error) {
      throw new Error(this.formatPromptError(error, `${model.providerID}/${model.modelID}`));
    }

    let parsed = safeJsonParse<SentryTriageOutput>(response);
    if (this.validateTriageOutput(parsed)) {
      return parsed;
    }

    // Retry once with error hint
    const retryPrompt = `${prompt}\n\n${promptErrorHint}`;
    try {
      response = await flue.client.prompt(retryPrompt, { model, result: v.string() });
    } catch (error) {
      throw new Error(this.formatPromptError(error, `${model.providerID}/${model.modelID}`));
    }

    parsed = safeJsonParse<SentryTriageOutput>(response);
    if (this.validateTriageOutput(parsed)) {
      return parsed;
    }

    throw new Error('Invalid triage output after retry: missing or incorrectly typed fields');
  }

  // ── Helper methods ───────────────────────────────────────────────────────────

  /**
   * Redact all tokens from stored context.
   */
  private async redactTokens(): Promise<void> {
    const storedContext = await this.state.storage.get<SentryTriageContext>(STATE_KEYS.context);
    if (storedContext) {
      storedContext.sentryAuthToken = '[REDACTED]';
      storedContext.githubToken = '[REDACTED]';
      if (storedContext.tracker) {
        storedContext.tracker.token = '[REDACTED]';
      }
      if (storedContext.callback) {
        storedContext.callback.callback_secret = '[REDACTED]';
      }
      await this.state.storage.put(STATE_KEYS.context, storedContext);
    }
  }

  /**
   * Mark the triage as failed and redact tokens.
   */
  private async failTriage(
    context: SentryTriageContext,
    error: string
  ): Promise<void> {
    const status = await this.state.storage.get<SentryTriageStatus>(STATE_KEYS.status);
    if (status) {
      status.state = 'failed';
      status.error = error;
      status.completedAt = new Date().toISOString();
      await this.state.storage.put(STATE_KEYS.status, status);
    }

    // Redact tokens
    await this.redactTokens();

    console.error('Sentry triage failed', { jobId: context.jobId, error });
  }

  /**
   * Check if we should retry after an error.
   * Don't retry on auth/invalid/quota errors.
   */
  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
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

  /**
   * Validate that the triage output has all required fields with correct types.
   */
  private validateTriageOutput(output: unknown): output is SentryTriageOutput {
    if (!output || typeof output !== 'object') return false;
    const obj = output as Record<string, unknown>;

    // Required string fields
    if (typeof obj.root_cause !== 'string' || !obj.root_cause) return false;
    if (typeof obj.stack_trace_summary !== 'string' || !obj.stack_trace_summary) return false;
    if (typeof obj.suggested_fix !== 'string' || !obj.suggested_fix) return false;

    // Required array field
    if (!Array.isArray(obj.affected_files)) return false;
    if (!obj.affected_files.every((f: unknown) => typeof f === 'string')) return false;

    // Confidence enum
    if (!['high', 'medium', 'low'].includes(obj.confidence as string)) return false;

    // Severity enum
    if (!['critical', 'error', 'warning'].includes(obj.severity as string)) return false;

    return true;
  }

  /**
   * Format an error from Flue prompt for logging.
   */
  private formatPromptError(error: unknown, model: string): string {
    if (!(error instanceof Error)) {
      return `Flue prompt failed for model '${model}': unknown error`;
    }
    return `Flue prompt failed for model '${model}': ${error.message}`;
  }
}

/**
 * Get a SentryTriageProcessor stub for a specific job ID.
 */
export function getSentryTriageProcessor(
  namespace: DurableObjectNamespace,
  jobId: string
): DurableObjectStub<SentryTriageProcessor> {
  const id = namespace.idFromName(jobId);
  return namespace.get(id) as DurableObjectStub<SentryTriageProcessor>;
}
