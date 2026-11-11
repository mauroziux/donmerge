/**
 * ReviewProcessor Durable Object
 *
 * Manages review state and provides RPC methods for the CodeReviewWorkflow.
 * The actual review execution is handled by the Cloudflare Workflow.
 */

import { DurableObject } from 'cloudflare:workers';

import type {
  WorkerEnv,
  ReviewResult,
  TrackedIssue,
} from './types';
import { loadTrackedIssues, saveTrackedIssues } from './issue-store';
import { buildReviewWorkflowInstanceId } from './workflow-id';

// State keys
const STATE_KEYS = {
  context: 'reviewContext',
  status: 'reviewStatus',
  /** Latest deferred request: a push/comment arrived while a run was active. */
  pendingLatest: 'reviewPendingLatest',
};

/**
 * How long a 'pending' review may stay pending before it is considered stale
 * and overridden by a new startReview() call.
 *
 * Background: the webhook pipeline enqueues to CODE_REVIEW_QUEUE, whose consumer
 * calls startReview() (sets 'pending') then Workflow.create(). If the consumer
 * is killed between those two steps (e.g. duplicate-delivery throw, deploy),
 * the DO would otherwise be stuck in 'pending' forever and block ALL future
 * reviews for that PR. This threshold allows recovery.
 */
const STALE_PENDING_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

/**
 * How long a 'running' review may stay running before it is considered stale.
 * A single LLM prompt may legitimately run 10 minutes and the whole LLM step
 * up to ~40, so this must stay ABOVE those budgets: the 5-minute pending
 * threshold must never kill a healthy long review (plan 004-U1).
 */
const STALE_RUNNING_THRESHOLD_MS = 50 * 60 * 1000; // 50 min

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
  model?: string; // Optional: override LLM model (push API)
  maxFiles?: number; // Optional: override max files to review (push API)
  initiatorKeyHash?: string; // Hash of API key that initiated the review (for status auth)
}

interface ReviewStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  /** Fencing token: updates carrying a different runId are ignored. */
  runId?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  result?: ReviewResult; // Stored on completion for status queries
}

export interface StartReviewResult {
  started: boolean;
  reason: 'started' | 'already_running' | 'stale_recovered' | 'deferred_new_push';
  /** Run identity for the run that owns the DO state (fencing token). */
  runId?: string;
}

interface EnvWithBindings extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
}

/** Identity of a review request: same identity = duplicate delivery. */
function requestFingerprint(context: ReviewContext): string {
  return JSON.stringify({
    headSha: context.headSha ?? null,
    instruction: context.instruction ?? null,
    focusFiles: (context.focusFiles ?? []).slice().sort(),
    retrigger: context.retrigger === true,
    commentId: context.commentId ?? null,
  });
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
   * Stores context and initializes status. Execution is handled by CodeReviewWorkflow.
   *
   * Returning an explicit result lets callers acknowledge duplicate deliveries
   * without creating or restarting another Workflow.
   */
  async startReview(context: ReviewContext): Promise<StartReviewResult> {
    // Check if there's already a review in progress. Allow overriding stale
    // 'pending'/'running' states so a crashed consumer doesn't permanently
    // block future reviews for this PR.
    const existingStatus = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (existingStatus && (existingStatus.state === 'running' || existingStatus.state === 'pending')) {
      const startedAtMs = existingStatus.startedAt ? Date.parse(existingStatus.startedAt) : 0;
      const ageMs = Date.now() - startedAtMs;
      // A healthy running review can legitimately take tens of minutes; only
      // a hung one is stale. Pending means the workflow never started.
      const threshold = existingStatus.state === 'pending'
        ? STALE_PENDING_THRESHOLD_MS
        : STALE_RUNNING_THRESHOLD_MS;
      const isStale = ageMs > threshold;
      if (!isStale) {
        const storedContext = await this.state.storage.get<ReviewContext>(STATE_KEYS.context);
        const sameRequest =
          storedContext !== undefined &&
          requestFingerprint(storedContext) === requestFingerprint(context);
        if (sameRequest) {
          console.log('Duplicate review delivery acknowledged without restarting', {
            state: existingStatus.state,
            ageMs,
          });
          return { started: false, reason: 'already_running', runId: existingStatus.runId };
        }
        // Different version or intent while a run is active: coalesce to the
        // latest request (only the latest survives). The terminal update of
        // the active run hands it off to a fresh workflow run — the push is
        // never dropped.
        await this.state.storage.put(STATE_KEYS.pendingLatest, context);
        console.log('Review deferred: run active, latest request stored for handoff', {
          activeState: existingStatus.state,
          activeRunId: existingStatus.runId,
          newHeadSha: context.headSha,
        });
        return { started: false, reason: 'deferred_new_push' };
      }
      console.log('Stale in-progress review detected, overriding', {
        state: existingStatus.state,
        ageMs,
        threshold,
      });
      // fall through to overwrite
    }

    const runId = crypto.randomUUID();

    // Store the context
    await this.state.storage.put(STATE_KEYS.context, context);
    // A fresh start invalidates any deferred request from a previous cycle
    await this.state.storage.delete(STATE_KEYS.pendingLatest);

    // Initialize status
    const status: ReviewStatus = {
      state: 'pending',
      attempts: 0,
      startedAt: new Date().toISOString(),
      runId,
    };
    await this.state.storage.put(STATE_KEYS.status, status);
    return {
      started: true,
      reason: existingStatus && (existingStatus.state === 'running' || existingStatus.state === 'pending')
        ? 'stale_recovered'
        : 'started',
      runId,
    };
  }

  /**
   * Get current review status.
   * If callerKeyHash is provided, verifies the caller is authorized to view this job.
   */
  async getStatus(callerKeyHash?: string): Promise<ReviewStatus | null> {
    const context = await this.state.storage.get<ReviewContext>(STATE_KEYS.context);

    // Authorization check: if the review was started with an initiatorKeyHash,
    // verify the caller matches
    if (context?.initiatorKeyHash && callerKeyHash) {
      if (context.initiatorKeyHash !== callerKeyHash) {
        throw new Error('Unauthorized: caller does not match job initiator');
      }
    }

    return (await this.state.storage.get<ReviewStatus>(STATE_KEYS.status)) ?? null;
  }

  // ── RPC methods called by CodeReviewWorkflow ──────────────────────────────

  /**
   * Update review status from the workflow.
   * Called by CodeReviewWorkflow via RPC on completion, failure, or progress.
   */
  async updateFromWorkflow(update: {
    state: ReviewStatus['state'];
    error?: string;
    completedAt?: string;
    result?: ReviewResult;
    /** Fencing token from the calling workflow run (plan 004-U1). */
    runId?: string;
  }): Promise<void> {
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (!status) return;

    // Run fencing: a late terminal write from a superseded run must not
    // clobber the state of the run that currently owns this DO. Legacy
    // instances deployed before runId existed may omit it — those are
    // accepted (explicit back-compat).
    if (update.runId && status.runId && update.runId !== status.runId) {
      console.warn('Ignoring stale workflow update from superseded run', {
        currentRunId: status.runId,
        updateRunId: update.runId,
        state: update.state,
      });
      return;
    }

    status.state = update.state;
    if (update.error !== undefined) status.error = update.error;
    if (update.completedAt !== undefined) status.completedAt = update.completedAt;
    if (update.result !== undefined) status.result = update.result;

    await this.state.storage.put(STATE_KEYS.status, status);

    // Redact github token from stored context after workflow completes
    if (update.state === 'complete' || update.state === 'failed') {
      const storedContext = await this.state.storage.get<ReviewContext>(STATE_KEYS.context);
      if (storedContext) {
        storedContext.githubToken = undefined;
        await this.state.storage.put(STATE_KEYS.context, storedContext);
      }
      // Durable handoff: if a newer request was deferred while this run was
      // active, start it now — in the DO, not in a memory-only callback.
      await this.startPendingLatestIfAny();
    }
  }

  /**
   * Fencing token for the workflow run that currently owns this DO.
   * CodeReviewWorkflow calls this once at start and echoes the runId on
   * every subsequent RPC so stale runs cannot overwrite fresh state.
   */
  async getRunId(): Promise<string | undefined> {
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    return status?.runId;
  }

  /**
   * Hand the latest deferred request to a fresh workflow run.
   * Uses a run-scoped instance id (`…-auto-<runId>`): the previous instance
   // is terminal and cannot carry the new request's params.
   */
  private async startPendingLatestIfAny(): Promise<void> {
    const pending = await this.state.storage.get<ReviewContext>(STATE_KEYS.pendingLatest);
    if (!pending) return;
    await this.state.storage.delete(STATE_KEYS.pendingLatest);

    const runId = crypto.randomUUID();
    await this.state.storage.put(STATE_KEYS.context, pending);
    await this.state.storage.put(STATE_KEYS.status, {
      state: 'pending',
      attempts: 0,
      startedAt: new Date().toISOString(),
      runId,
    });

    if (!this.env.CODE_REVIEW_WORKFLOW) {
      console.warn('Deferred review cannot start: CODE_REVIEW_WORKFLOW binding missing', {
        owner: pending.owner,
        repo: pending.repo,
        prNumber: pending.prNumber,
      });
      return;
    }

    const baseId = buildReviewWorkflowInstanceId(
      pending.owner,
      pending.repo,
      pending.prNumber,
      pending.commentId
    );
    const instanceId = `${baseId}-auto-${runId.slice(0, 8)}`;
    try {
      await this.env.CODE_REVIEW_WORKFLOW.create({
        id: instanceId,
        params: {
          owner: pending.owner,
          repo: pending.repo,
          prNumber: pending.prNumber,
          retrigger: pending.retrigger,
          commentId: pending.commentId,
          commentType: pending.commentType,
          installationId: pending.installationId,
          instruction: pending.instruction,
          focusFiles: pending.focusFiles,
          githubToken: pending.githubToken,
          model: pending.model,
          maxFiles: pending.maxFiles,
        },
      });
      console.log('Deferred review handed off to a new workflow run', { instanceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already_exists')) {
        try {
          const instance = await this.env.CODE_REVIEW_WORKFLOW.get(instanceId);
          await instance.restart();
          console.log('Deferred review restarted existing instance', { instanceId });
        } catch (restartError) {
          console.error('Deferred review restart failed', {
            instanceId,
            error: restartError instanceof Error ? restartError.message : String(restartError),
          });
        }
      } else {
        console.error('Deferred review workflow create failed', { instanceId, error: message });
      }
    }
  }

  /**
   * Load tracked issues from DO storage.
   * Called by CodeReviewWorkflow via RPC.
   */
  async loadTrackedIssuesRpc(): Promise<TrackedIssue[]> {
    return loadTrackedIssues(this.state.storage);
  }

  /**
   * Save tracked issues to DO storage.
   * Called by CodeReviewWorkflow via RPC. Fenced by runId: a superseded run
   * cannot rewrite the issue store of the run that owns the DO (plan 004-U1).
   */
  async saveTrackedIssuesRpc(issues: TrackedIssue[], runId?: string): Promise<void> {
    if (runId) {
      const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
      if (status?.runId && runId !== status.runId) {
        console.warn('Ignoring issue save from superseded run', {
          currentRunId: status.runId,
          updateRunId: runId,
        });
        return;
      }
    }
    await saveTrackedIssues(this.state.storage, issues);
  }

  // ── End RPC methods ───────────────────────────────────────────────────────
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
