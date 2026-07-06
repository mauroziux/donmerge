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
  model?: string; // Optional: override LLM model (push API)
  maxFiles?: number; // Optional: override max files to review (push API)
  initiatorKeyHash?: string; // Hash of API key that initiated the review (for status auth)
}

interface ReviewStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  result?: ReviewResult; // Stored on completion for status queries
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
   * Stores context and initializes status. Execution is handled by CodeReviewWorkflow.
   */
  async startReview(context: ReviewContext): Promise<void> {
    // Check if there's already a review in progress
    const existingStatus = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (existingStatus?.state === 'running' || existingStatus?.state === 'pending') {
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
  }): Promise<void> {
    const status = await this.state.storage.get<ReviewStatus>(STATE_KEYS.status);
    if (!status) return;

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
   * Called by CodeReviewWorkflow via RPC.
   */
  async saveTrackedIssuesRpc(issues: TrackedIssue[]): Promise<void> {
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
