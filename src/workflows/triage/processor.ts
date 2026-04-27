/**
 * TriageProcessor Durable Object
 *
 * Handles long-running error triage analysis using alarms for reliable execution.
 * Mirrors the ReviewProcessor pattern: alarm-based lifecycle, retry logic, token redaction.
 *
 * DonMerge receives error context from the caller — it does NOT fetch from Sentry
 * or any other external service. The caller provides all context; DonMerge provides compute.
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';
import * as v from 'valibot';

import type {
  TriageEnv,
  TriageContext,
  TriageStatus,
  TriageResult,
  TriageOutput,
} from './types';
import { fetchRepoCodeForTriage } from './repo-fetcher';
import { buildTriagePrompt } from './prompts';
import { runAutoFix } from './auto-fix';
import { runCreateIssue } from './trackers';
import { parseModelConfig, safeJsonParse, extractRawFlueResponse, extractJsonFromResponse } from './utils';

// State keys
const STATE_KEYS = {
  context: 'triageContext',
  status: 'triageStatus',
} as const;

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10000;

interface EnvWithBindings extends TriageEnv {
  TriageProcessor: DurableObjectNamespace;
}

export class TriageProcessor extends DurableObject<EnvWithBindings> {
  private state: DurableObjectState;
  private env: EnvWithBindings;

  constructor(state: DurableObjectState, env: EnvWithBindings) {
    super(state, env);
    this.state = state;
    this.env = env;
  }

  /**
   * Start a new triage. Called from the API route handler.
   */
  async startTriage(context: TriageContext): Promise<void> {
    // Check if there's already a triage in progress
    const existingStatus = await this.state.storage.get<TriageStatus>(STATE_KEYS.status);
    if (existingStatus?.state === 'running') {
      console.log('Triage already in progress, skipping');
      return;
    }

    // Store the context
    await this.state.storage.put(STATE_KEYS.context, context);

    // Initialize status
    const status: TriageStatus = {
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
  async getStatus(callerKeyHash?: string): Promise<TriageStatus | null> {
    if (callerKeyHash) {
      const context = await this.state.storage.get<TriageContext>(STATE_KEYS.context);
      if (context?.initiatorKeyHash && context.initiatorKeyHash !== callerKeyHash) {
        throw new Error('not found: caller key hash does not match initiator');
      }
    }
    return (await this.state.storage.get<TriageStatus>(STATE_KEYS.status)) ?? null;
  }

  /**
   * Alarm handler - runs the triage in a fresh execution context.
   */
  async alarm(): Promise<void> {
    const context = await this.state.storage.get<TriageContext>(STATE_KEYS.context);
    const status = await this.state.storage.get<TriageStatus>(STATE_KEYS.status);

    if (!context || !status) {
      console.error('TriageProcessor: No context or status found');
      return;
    }

    // Skip if already complete or failed
    if (status.state === 'complete' || status.state === 'failed') {
      console.log('Triage already terminal', { state: status.state });
      return;
    }

    // Update status
    status.state = 'running';
    status.attempts += 1;
    await this.state.storage.put(STATE_KEYS.status, status);

    console.log('TriageProcessor alarm fired', {
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
      console.error('TriageProcessor error', { attempt: status.attempts, error: message });

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
   * Run the full triage process.
   */
  private async runTriage(
    context: TriageContext,
    status: TriageStatus
  ): Promise<void> {
    const { errorContext } = context;

    // 1. Fetch repo code from affected file paths (provided by caller)
    console.log('Fetching repo code', {
      repo: context.repo,
      sha: context.sha,
      affectedFiles: errorContext.affected_files.length,
    });
    const sourceCode = await fetchRepoCodeForTriage(
      context.repo,
      context.sha,
      errorContext.affected_files,
      context.githubToken
    );

    // 2. Create shared sandbox+flue for both triage and auto-fix
    const sessionId = `triage-${context.jobId}`;
    const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: '30m' });
    const flue = new FlueRuntime({ sandbox, sessionId, workdir: '/home/user' });
    await sandbox.setEnvVars({ OPENAI_API_KEY: this.env.OPENAI_API_KEY });
    await flue.setup();

    // 3. Run LLM triage
    console.log('Running LLM triage', { sourceFiles: sourceCode.size });
    const output = await this.runLlmTriage(context, sourceCode, flue);

    // 4. Build result
    const result: TriageResult = {
      root_cause: output.root_cause,
      stack_trace_summary: output.stack_trace_summary,
      affected_files: output.affected_files,
      suggested_fix: output.suggested_fix,
      confidence: output.confidence,
      severity: output.severity,
      fix_pr_url: null,
      tracker_issue_url: null,
    };

    // 5. Auto-fix — non-blocking (defaults to true)
    if (context.options?.auto_fix !== false) {
      try {
        const prUrl = await runAutoFix(
          {
            repo: context.repo,
            sha: context.sha,
            githubToken: context.githubToken,
            errorTitle: errorContext.title,
            sourceUrl: errorContext.source_url ?? '',
            triageOutput: output,
            sourceCode,
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

    // 6. Tracker issue creation — always when tracker configured
    if (context.tracker) {
      const issueUrl = await runCreateIssue({
        repo: context.repo,
        errorTitle: errorContext.title,
        sourceUrl: errorContext.source_url ?? '',
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

    // callback invocation — invoke context.callback here if present

    console.log('Triage completed successfully', {
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
    context: TriageContext,
    sourceCode: Map<string, string>,
    flue: FlueRuntime
  ): Promise<TriageOutput> {
    const model = parseModelConfig(this.env.CODEX_MODEL);
    const prompt = buildTriagePrompt({
      errorContext: context.errorContext,
      sourceCode,
      sha: context.sha,
      repo: context.repo,
      options: context.options,
    });

    const promptErrorHint =
      'Your previous response was invalid. Produce valid JSON matching the schema exactly. ' +
      'Ensure root_cause, stack_trace_summary, affected_files (array), suggested_fix, confidence (high|medium|low), ' +
      'and severity (critical|error|warning) are all present and correctly typed.';

    let response: string | undefined;
    try {
      response = await flue.client.prompt(prompt, { model, result: v.string() });
    } catch (error) {
      const raw = extractRawFlueResponse(error);
      if (raw) {
        try {
          const json = extractJsonFromResponse(raw);
          const parsed = safeJsonParse<TriageOutput>(json);
          if (this.validateTriageOutput(parsed)) {
            return parsed;
          }
          response = raw;
        } catch { /* fall through */ }
      }
      if (!response) {
        throw new Error(this.formatPromptError(error, `${model.providerID}/${model.modelID}`));
      }
    }

    let parsed = safeJsonParse<TriageOutput>(response);
    if (this.validateTriageOutput(parsed)) {
      return parsed;
    }

    // Retry once with error hint
    const retryPrompt = `${prompt}\n\n${promptErrorHint}`;
    try {
      response = await flue.client.prompt(retryPrompt, { model, result: v.string() });
    } catch (error) {
      const raw = extractRawFlueResponse(error);
      if (raw) {
        try {
          const json = extractJsonFromResponse(raw);
          const retryParsed = safeJsonParse<TriageOutput>(json);
          if (this.validateTriageOutput(retryParsed)) {
            return retryParsed;
          }
          response = raw;
        } catch { /* fall through */ }
      }
      if (!response) {
        throw new Error(this.formatPromptError(error, `${model.providerID}/${model.modelID}`));
      }
    }

    parsed = safeJsonParse<TriageOutput>(response);
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
    const storedContext = await this.state.storage.get<TriageContext>(STATE_KEYS.context);
    if (storedContext) {
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
    context: TriageContext,
    error: string
  ): Promise<void> {
    const status = await this.state.storage.get<TriageStatus>(STATE_KEYS.status);
    if (status) {
      status.state = 'failed';
      status.error = error;
      status.completedAt = new Date().toISOString();
      await this.state.storage.put(STATE_KEYS.status, status);
    }

    // Redact tokens
    await this.redactTokens();

    console.error('Triage failed', { jobId: context.jobId, error });
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
  private validateTriageOutput(output: unknown): output is TriageOutput {
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
 * Get a TriageProcessor stub for a specific job ID.
 */
export function getTriageProcessor(
  namespace: DurableObjectNamespace,
  jobId: string
): DurableObjectStub<TriageProcessor> {
  const id = namespace.idFromName(jobId);
  return namespace.get(id) as DurableObjectStub<TriageProcessor>;
}
