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
  handoff: 'reviewHandoff',
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

/** Identity of a review request: same identity = duplicate delivery.
 * Includes everything that changes what the run would do (head, instruction,
 * focus, model, file limits, installation credentials, comment) so two API
 * requests with different parameters are NEVER conflated as duplicates. */
function requestFingerprint(context: ReviewContext): string {
  return JSON.stringify({
    headSha: context.headSha ?? null,
    instruction: context.instruction ?? null,
    focusFiles: (context.focusFiles ?? []).slice().sort(),
    retrigger: context.retrigger === true,
    commentId: context.commentId ?? null,
    model: context.model ?? null,
    maxFiles: context.maxFiles ?? null,
    installationId: context.installationId ?? null,
  });
}

/** Deterministic FNV-1a hex token: same deferred request → same instance id
 * on every retry, so handoffs cannot spawn duplicate workflow instances. */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
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
      // A live or suspended workflow can still execute external GitHub writes.
      // Time alone cannot fence those writes, so never replace a running owner
      // solely by age; recovery must reconcile the workflow's actual state.
      const deferred = await this.state.storage.get<ReviewContext>(STATE_KEYS.pendingLatest);
      const handoff = await this.state.storage.get(STATE_KEYS.handoff);
      // Age is not proof that a fenced workflow was never created. Only
      // recover a legacy, unfenced pending record if no request can be lost.
      const isStale = existingStatus.state === 'pending' && !existingStatus.runId &&
        !deferred && !handoff && ageMs > threshold;
      if (!isStale) {
        const storedContext = await this.state.storage.get<ReviewContext>(STATE_KEYS.context);
        const sameRequest =
          storedContext !== undefined &&
          requestFingerprint(storedContext) === requestFingerprint(context);
        if (sameRequest) {
          // A duplicate delivery may arrive after a newer push; never allow it
          // to overwrite the deferred request. The next run fetches the live PR.
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
        await this.state.storage.setAlarm(Date.now() + 60_000);
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
    /** Head the terminating run actually reviewed (suppression signal). */
    headSha?: string;
  }): Promise<boolean> {
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (!status) return false;

    // Run fencing: a late terminal write from a superseded run must not
    // clobber the state of the run that currently owns this DO.
    //   - runId mismatch → reject.
    //   - update WITHOUT runId while an owner WITH runId exists → reject too:
    //     a legacy instance writing alongside a fenced owner is by definition
    //     not the owner. runId-less updates are only accepted while the stored
    //     status itself predates fencing (pure legacy session).
    if (update.runId && status.runId && update.runId !== status.runId) {
      console.warn('Ignoring stale workflow update from superseded run', {
        currentRunId: status.runId,
        updateRunId: update.runId,
        state: update.state,
      });
      return false;
    }
    if (!update.runId && status.runId) {
      console.warn('Ignoring legacy (runId-less) update while a fenced owner exists', {
        currentRunId: status.runId,
        state: update.state,
      });
      return false;
    }
    if (update.state === 'running' && (status.state === 'complete' || status.state === 'failed')) {
      return false;
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
      // active, start it now — in the DO, not in a memory-only callback. The
      // completed run's identity (fingerprint, enriched with the terminal
      // head when known) suppresses a deferred DUPLICATE of the very request
      // we just ran — different intent on the same head still runs.
      await this.startPendingLatestIfAny(
        update.state === 'complete' ? storedContext : undefined,
        update.headSha ?? storedContext?.headSha
      );
    }
    return true;
  }

  /** Reserve a publication before its POST. A reservation is never cleared
   * automatically: a lost response cannot safely be distinguished from success. */
  async reservePublication(runId: string): Promise<boolean> {
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (!status || status.runId !== runId) return false;
    const key = `publication:${runId}`;
    if (await this.state.storage.get(key)) return false;
    await this.state.storage.put(key, true);
    return true;
  }

  /**
   * Fencing token for the workflow run that currently owns this DO.
   * Runs now carry their identity in Workflow params (plan 004-U1); this RPC
   * remains for diagnostics/status tooling.
   */
  async getRunId(): Promise<string | undefined> {
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    return status?.runId;
  }

  /**
   * Alarm: retry a handoff whose workflow creation failed transiently.
   * pendingLatest survives failed handoffs — a deferred push is never lost.
   */
  async alarm(): Promise<void> {
    await this.startPendingLatestIfAny();
  }

  /**
   * Hand the latest deferred request to a fresh workflow run.
   *
   * Durability contract (plan 004-U1):
   *   - the workflow is created BEFORE the deferred request is consumed; a
   *     transient failure (or a crash mid-handoff) leaves pendingLatest in
   *     place and an alarm retries;
   *   - the instance id and run token are DERIVED from the request
   *     fingerprint, so retrying the same deferred request reuses the same
   *     instance (already_exists → restart) instead of spawning duplicates.
   */
  private async startPendingLatestIfAny(
    completedContext?: ReviewContext,
    completedHeadSha?: string
  ): Promise<void> {
    const latest = await this.state.storage.get<ReviewContext>(STATE_KEYS.pendingLatest);
    let existingHandoff = await this.state.storage.get<{ fingerprint: string; runId: string; context?: ReviewContext }>(STATE_KEYS.handoff);
    const currentStatus = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    // A terminal handoff has finished even if create's response was lost.
    // Clear its intent before considering the latest deferred request.
    if (existingHandoff && currentStatus?.runId === existingHandoff.runId &&
        (currentStatus.state === 'complete' || currentStatus.state === 'failed')) {
      await this.state.storage.delete(STATE_KEYS.handoff);
      existingHandoff = undefined;
    }
    const pending = existingHandoff?.context ?? latest;
    if (!pending) return;
    // An alarm while an unrelated run is active must not freeze an intent for
    // a request that can still be superseded before that run completes.
    if ((currentStatus?.state === 'pending' || currentStatus?.state === 'running') &&
        (!existingHandoff || currentStatus.runId !== existingHandoff.runId)) {
      await this.state.storage.setAlarm(Date.now() + 60_000);
      return;
    }

    // Serialization: never hand off while another run owns the DO and is
    // pending/running — its own terminal update (or a later alarm, once it
    // has finished) delivers the deferred request. Overcommitting now would
    // orphan a live owner. Exception: resuming OUR OWN committed handoff
    // (same deterministic token) after a crash between commit and create.
    const fingerprint = requestFingerprint(pending);
    let handoff = existingHandoff;
    if (!handoff || handoff.fingerprint !== fingerprint) {
      handoff = { fingerprint, runId: crypto.randomUUID(), context: pending };
      await this.state.storage.put(STATE_KEYS.handoff, handoff);
    }
    const runId = handoff.runId;
    const token = runId;
    if (
      currentStatus &&
      (currentStatus.state === 'pending' || currentStatus.state === 'running') &&
      currentStatus.runId !== runId
    ) {
      console.log('Handoff deferred: another run owns the DO — its terminal update will deliver', {
        ownerRunId: currentStatus.runId,
        state: currentStatus.state,
      });
      await this.state.storage.setAlarm(Date.now() + 60_000);
      return;
    }

    // Superseded duplicate: the just-completed run already ran THIS EXACT
    // request (full identity — head, instruction, focus, model, limits), not
    // merely the same head. A different intent on the same head still runs.
    if (completedContext) {
      const completedFingerprint = requestFingerprint({
        ...completedContext,
        headSha: completedHeadSha ?? completedContext.headSha,
      });
      if (completedFingerprint === requestFingerprint(pending)) {
        console.log('Deferred request duplicates the just-completed run — superseded, dropping');
        await this.state.storage.delete(STATE_KEYS.pendingLatest);
        await this.state.storage.delete(STATE_KEYS.handoff);
        await this.state.storage.deleteAlarm();
        return;
      }
    }

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
    const instanceId = `${baseId}-auto-${token}`;

    // Safety alarm FIRST: any crash from here on retries the same
    // deterministic instance id instead of losing the deferred push.
    await this.state.storage.setAlarm(Date.now() + 60_000);

    // Commit ownership BEFORE creating the workflow: the new run's token is
    // registered before the instance can exist, so its first write is never
    // rejected by fencing (judge-hardened plan 004-U1). pendingLatest stays
    // stored until the create succeeds — the alarm re-runs this handoff on
    // any interruption, converging on the same instance id.
    if (currentStatus?.runId !== runId || currentStatus.state !== 'running') {
      await this.state.storage.put(STATE_KEYS.context, pending);
      await this.state.storage.put(STATE_KEYS.status, {
        state: 'pending',
        attempts: 0,
        startedAt: new Date().toISOString(),
        runId,
      });
    }

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
          runId,
        },
      });
      console.log('Deferred review handed off to a new workflow run', { instanceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already_exists')) {
        try {
          // Same request handed off before (deterministic id). If an instance
          // is ALREADY running this request, coalesce: restarting a live
          // instance would duplicate the work. NOTE: the SDK's status()
          // resolves to { status }, not a bare string.
          const instance = await this.env.CODE_REVIEW_WORKFLOW.get(instanceId);
          const statusResult = await (
            instance as unknown as { status: () => Promise<{ status?: string } | string> }
          ).status();
          const statusValue =
            typeof statusResult === 'string' ? statusResult : statusResult?.status;
          if (statusValue === 'running' || statusValue === 'queued') {
            console.log('Deferred review already has a live instance — coalescing', { instanceId });
          } else {
            await instance.restart();
            console.log('Deferred review restarted existing instance', { instanceId });
          }
        } catch (restartError) {
          console.error('Deferred review restart failed; alarm will retry', {
            instanceId,
            error: restartError instanceof Error ? restartError.message : String(restartError),
          });
          await this.state.storage.setAlarm(Date.now() + 30_000);
          return;
        }
      } else {
        console.error('Deferred review workflow create failed; alarm will retry', {
          instanceId,
          error: message,
        });
        // A transport error can mean create succeeded. Retain this handoff's
        // owner and identity; the alarm retries the same instance, not a newer
        // request, until its outcome is reconciled.
        await this.state.storage.setAlarm(Date.now() + 30_000);
        return;
      }
    }

    // Instance exists (created, restarted or coalesced). Consume the deferred
    // request ONLY if a newer request did not replace it while we were
    // awaiting the create: losing that newer intent would drop a push. When
    // replaced, leave it stored and keep the alarm armed for its own handoff.
    // create() may return after this handoff already finished and a newer one
    // took ownership. Never clear another generation's intent or alarm.
    const currentHandoff = await this.state.storage.get<{ runId: string }>(STATE_KEYS.handoff);
    if (currentHandoff?.runId !== runId) return;
    const currentPending = await this.state.storage.get<ReviewContext>(STATE_KEYS.pendingLatest);
    if (currentPending && requestFingerprint(currentPending) === requestFingerprint(pending)) {
      await this.state.storage.delete(STATE_KEYS.pendingLatest);
      await this.state.storage.delete(STATE_KEYS.handoff);
      await this.state.storage.deleteAlarm();
    } else if (currentPending) {
      console.log('Deferred request was replaced during handoff — newer request kept', {
        instanceId,
      });
      await this.state.storage.delete(STATE_KEYS.handoff);
      await this.state.storage.setAlarm(Date.now() + 30_000);
    } else {
      await this.state.storage.deleteAlarm();
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
