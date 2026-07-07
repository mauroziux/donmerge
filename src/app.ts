import { FlueWorker } from '@flue/cloudflare/worker';
import { validateWebhookFast } from './workflows/code-review';
import type { WorkerEnv, WebhookContext } from './workflows/code-review';
import { ReviewProcessor } from './workflows/code-review/processor';
import { CodeReviewWorkflow } from './workflows/code-review/code-review-workflow';
import { TriageProcessor } from './workflows/triage/processor';
import { handlePushReview, handleTriage, handleJobStatus } from './api/routes';
import { RateLimiter } from './api/rate-limit';
import { handleSentryWebhook } from './webhooks/sentry';
import { handleCodeReviewQueue } from './queues/code-review-consumer';

// Extended env type that includes all DO bindings
interface AppEnv extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
  TriageProcessor: DurableObjectNamespace;
  RateLimiter: DurableObjectNamespace;
  DONMERGE_API_KEYS?: string;
  SENTRY_WEBHOOK_SECRET?: string;
  SENTRY_REPO_MAP?: string;
  SENTRY_GITHUB_TOKEN?: string;
  CODE_REVIEW_WORKFLOW?: Workflow;
  CODE_REVIEW_QUEUE: Queue<WebhookContext>;
  // Multi-tenant D1 database (Phase 1)
  DB?: D1Database;
  TENANT_ENCRYPTION_KEY?: string;
}

const app = new FlueWorker<AppEnv>();

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'codex-review-webhook' });
});

app.post('/webhook/github', async (c) => {
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const event = c.req.header('x-github-event') ?? '';
  const rawBody = await c.req.text();

  // Fast validation (signature, repo allowlist, trigger check)
  const validation = await validateWebhookFast(c.env, event, signature, rawBody);

  // If validation fails or event should be skipped, respond immediately
  if (!validation.shouldProcess) {
    return c.json(validation.body, validation.status);
  }

  // Enqueue to the code-review queue. The consumer (handleCodeReviewQueue)
  // runs the pipeline with a 15-minute wall-clock budget — vs the 30s
  // waitUntil cap that was cancelling Workflow.create() mid-flight.
  await c.env.CODE_REVIEW_QUEUE.send(validation.context!);

  // Return 202 Accepted immediately
  return c.json(
    {
      ok: true,
      accepted: true,
      message: 'Review queued for processing',
      prNumber: validation.context?.prNumber,
    },
    202
  );
});

// Push API routes
app.post('/api/v1/review', handlePushReview);
app.post('/api/v1/triage', handleTriage);
app.get('/api/v1/status/*', handleJobStatus);

// Sentry webhook — receives Sentry event_alert webhooks directly
app.post('/webhook/sentry', handleSentryWebhook);

// Export Durable Objects
export { Sandbox } from '@cloudflare/sandbox';
export { ReviewProcessor };
export { CodeReviewWorkflow };
export { TriageProcessor };
export { RateLimiter };

// Worker entrypoint: Hono fetch + Queue consumer.
// FlueWorker extends Hono so app.fetch is the standard Worker fetch handler;
// binding it preserves `this` for route lookup.
export default {
  fetch: app.fetch.bind(app),
  queue: handleCodeReviewQueue,
};
