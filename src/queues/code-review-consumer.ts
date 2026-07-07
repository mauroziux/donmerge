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
 * ReviewProcessor DO's startReview() de-dupes within STALE_PENDING_THRESHOLD_MS,
 * and Workflow.create() with a deterministic id will throw on the duplicate —
 * that throw is caught here and treated as a soft failure (the original
 * workflow instance from the first delivery continues to run).
 */

import type { WorkerEnv, WebhookContext } from '../workflows/code-review/types';
import { processGitHubCodeReviewWebhook } from '../workflows/code-review/webhook';

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
    try {
      await processGitHubCodeReviewWebhook(env, msg.body);
      msg.ack();
    } catch (error) {
      console.error('code-review-jobs: message failed', {
        messageId: msg.id,
        owner: msg.body?.owner,
        repo: msg.body?.repo,
        prNumber: msg.body?.prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      // Retry with backoff; after max_retries the platform routes to the DLQ.
      msg.retry({ delaySeconds: 30 });
    }
  }
}
