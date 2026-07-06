/**
 * Webhook validation and processing for code review.
 *
 * Uses ReviewProcessor Durable Object for status tracking and concurrency control.
 * Actual review execution is handled by CodeReviewWorkflow.
 */

import type { WorkerEnv, WebhookPayload, FastValidationResult, WebhookContext } from './types';
import { verifyWebhookSignature, isRepoAllowed } from './github-auth';
import { parseTrigger } from './triggers';
import { getReviewProcessor } from './processor';

interface EnvWithReviewProcessor extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
  CODE_REVIEW_WORKFLOW?: Workflow;
}

/**
 * Fast validation that completes within GitHub's 10s timeout.
 * Validates signature, repo allowlist, and trigger conditions.
 * Returns context needed for background processing.
 */
export async function validateWebhookFast(
  env: WorkerEnv,
  event: string,
  signature: string,
  rawBody: string
): Promise<FastValidationResult> {
  const isValid = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!isValid) {
    return { shouldProcess: false, status: 401, body: { error: 'invalid signature' } };
  }

  const payload = JSON.parse(rawBody) as WebhookPayload;
  const owner = payload.repository?.owner.login;
  const repo = payload.repository?.name;

  if (!owner || !repo) {
    return { shouldProcess: false, status: 400, body: { error: 'missing repository context' } };
  }

  if (!isRepoAllowed(owner, repo, env.REPO_CONFIGS)) {
    return {
      shouldProcess: false,
      status: 403,
      body: {
        error: 'repository not allowed',
        repository: owner + '/' + repo,
      },
    };
  }

  console.log('Webhook received', {
    event,
    action: payload.action,
    owner,
    repo,
    prNumber: payload.pull_request?.number ?? payload.issue?.number ?? null,
  });

  const trigger = parseTrigger(event, payload, env.REVIEW_TRIGGER);
  if (!trigger.shouldRun) {
    return { shouldProcess: false, status: 200, body: { ok: true, skipped: true, reason: trigger.reason } };
  }

  return {
    shouldProcess: true,
    status: 202,
    body: { ok: true, accepted: true },
    context: {
      owner,
      repo,
      prNumber: trigger.prNumber,
      retrigger: trigger.retrigger,
      commentId: trigger.commentId,
      commentType: trigger.commentType,
      installationId: payload.installation?.id,
      instruction: trigger.instruction,
      focusFiles: trigger.focusFiles,
    },
  };
}

/**
 * Start background processing of the code review.
 * Delegates to ReviewProcessor DO for status tracking and CodeReviewWorkflow for execution.
 */
export async function processGitHubCodeReviewWebhook(
  env: EnvWithReviewProcessor,
  context: WebhookContext
): Promise<void> {
  const { owner, repo, prNumber, retrigger, commentId, commentType, installationId, instruction } =
    context;
  const focusFiles = context.focusFiles;

  console.log('Starting review via ReviewProcessor + CodeReviewWorkflow', {
    owner,
    repo,
    prNumber,
    retrigger,
    hasInstruction: !!instruction,
    focusFilesCount: focusFiles?.length ?? 0,
  });

  // Get the ReviewProcessor DO for this PR
  const processor = getReviewProcessor(env.ReviewProcessor, owner, repo, prNumber);

  // Start the review (stores context, initializes status in DO)
  await (processor as unknown as { startReview(ctx: {
    owner: string; repo: string; prNumber: number; retrigger: boolean;
    commentId?: number; commentType?: 'issue' | 'review';
    installationId?: number; instruction?: string; focusFiles?: string[];
  }): Promise<void> }).startReview({
    owner,
    repo,
    prNumber,
    retrigger,
    commentId,
    commentType,
    installationId,
    instruction,
    focusFiles,
  });

  // Create the workflow to handle execution
  if (env.CODE_REVIEW_WORKFLOW) {
    await env.CODE_REVIEW_WORKFLOW.create({
      id: `review/${owner}/${repo}/${prNumber}`,
      params: {
        owner,
        repo,
        prNumber,
        retrigger,
        commentId,
        commentType,
        installationId,
        instruction,
        focusFiles,
      },
    });
  } else {
    console.warn('CODE_REVIEW_WORKFLOW not bound — review queued in DO but will not execute');
  }
}
