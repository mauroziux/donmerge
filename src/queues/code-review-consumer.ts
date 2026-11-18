/**
 * Queue consumer for code-review jobs.
 *
 * Decouples the GitHub webhook HTTP request from the (long-running) workflow
 * creation step. The webhook handler enqueues a WebhookContext; this consumer
 * runs in a Queue invocation with a 15-minute wall-clock budget (vs the 30s
 * waitUntil cap), calls the existing processGitHubCodeReviewWebhook(), and
 * acks/retries each message individually.
 *
 * At-least-once delivery: duplicate messages are possible on retry. The
 * ReviewProcessor DO's startReview() de-dupes within STALE_PENDING_THRESHOLD_MS.
 * If Workflow.create() throws "already_exists" (instance from a previous errored
 * run still within retention), the consumer restarts the existing instance per
 * CF docs rather than retrying into the DLQ.
 */

import type { WorkerEnv, WebhookContext } from '../workflows/code-review/types';
import { processGitHubCodeReviewWebhook } from '../workflows/code-review/webhook';
import { buildReviewWorkflowInstanceId } from '../workflows/code-review/workflow-id';
import { fetchPrHeadSha } from '../workflows/code-review/github-api';
import { resolveGitHubToken } from '../workflows/code-review/github-auth';
import { isDebounceEnabled } from './push-debounce';

/**
 * Env required by the consumer: every binding the webhook pipeline needs
 * (DO + Workflow), plus the queue binding itself (declared here for producer
 * code; the consumer only reads from it).
 */
export interface EnvWithQueue extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
  TriageProcessor: DurableObjectNamespace;
  RateLimiter: DurableObjectNamespace;
  CODE_REVIEW_WORKFLOW?: Workflow;
  CODE_REVIEW_QUEUE?: Queue<WebhookContext>;
}

/**
 * Queue consumer entrypoint. Wired into the Worker default export as `queue`.
 *
 * Per-message semantics:
 *   - success → msg.ack()
 *   - throw   → console.error + msg.retry({ delaySeconds: 30 })
 *
 * After max_retries (configured in wrangler.jsonc) the message lands on the
 * dead-letter queue (code-review-jobs-dlq) for inspection.
 */
export async function handleCodeReviewQueue(
  batch: MessageBatch<WebhookContext>,
  env: EnvWithQueue
): Promise<void> {
  for (const msg of batch.messages) {
    // Push-debounce supersession (cost control): a delayed synchronize message
    // only runs if it is STILL the PR's head — a newer push supersedes it (and
    // that newer push carries its own, also-debounced delivery). A head check
    // failure is retried, never silently dropped: losing a review to a GitHub
    // outage would be worse than delaying it.
    if (isDebounceEnabled(env) && msg.body?.triggerAction === 'synchronize' && msg.body?.headSha) {
      try {
        const token = await resolveGitHubToken(env, msg.body.installationId);
        const currentHead = await fetchPrHeadSha(msg.body.owner, msg.body.repo, msg.body.prNumber, token);
        if (currentHead !== msg.body.headSha) {
          console.log('code-review-jobs: debounced push superseded by newer head — dropped', {
            messageId: msg.id,
            owner: msg.body.owner,
            repo: msg.body.repo,
            prNumber: msg.body.prNumber,
            queuedHeadSha: msg.body.headSha,
            currentHeadSha: currentHead,
          });
          msg.ack();
          continue;
        }
      } catch (error) {
        console.error('code-review-jobs: head check failed for debounced push — retrying', {
          messageId: msg.id,
          owner: msg.body?.owner,
          repo: msg.body?.repo,
          prNumber: msg.body?.prNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        msg.retry({ delaySeconds: 30 });
        continue;
      }
    }

    try {
      await processGitHubCodeReviewWebhook(env, msg.body);
      msg.ack();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // Workflow instance already exists (previous errored run within retention).
      // Per CF docs: "To re-run a workflow with the same ID, restart the existing instance."
      if (errMsg.includes('already_exists') && env.CODE_REVIEW_WORKFLOW) {
        try {
          const { owner, repo, prNumber, commentId } = msg.body;
          const instanceId = buildReviewWorkflowInstanceId(owner, repo, prNumber, commentId);
          const instance = await env.CODE_REVIEW_WORKFLOW.get(instanceId);
          await instance.restart();
          console.log('code-review-jobs: restarted existing workflow instance', {
            messageId: msg.id,
            instanceId,
            owner,
            repo,
            prNumber,
          });
          msg.ack();
        } catch (restartError) {
          console.error('code-review-jobs: failed to restart existing instance', {
            messageId: msg.id,
            owner: msg.body?.owner,
            repo: msg.body?.repo,
            prNumber: msg.body?.prNumber,
            error: restartError instanceof Error ? restartError.message : String(restartError),
          });
          msg.retry({ delaySeconds: 30 });
        }
      } else {
        console.error('code-review-jobs: message failed', {
          messageId: msg.id,
          owner: msg.body?.owner,
          repo: msg.body?.repo,
          prNumber: msg.body?.prNumber,
          error: errMsg,
        });
        // Retry with backoff; after max_retries the platform routes to the DLQ.
        msg.retry({ delaySeconds: 30 });
      }
    }
  }
}
