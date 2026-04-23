import { FlueWorker } from '@flue/cloudflare/worker';
import { processGitHubCodeReviewWebhook, validateWebhookFast } from './workflows/code-review';
import type { WorkerEnv } from './workflows/code-review';
import { ReviewProcessor } from './workflows/code-review/processor';

// Extended env type that includes the ReviewProcessor binding
interface AppEnv extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
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

  // Start review via ReviewProcessor Durable Object
  // This is non-blocking - the DO will handle everything via alarms
  c.executionCtx.waitUntil(
    processGitHubCodeReviewWebhook(c.env, validation.context!)
  );

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

// Export Durable Objects
export { Sandbox } from '@cloudflare/sandbox';
export { ReviewProcessor };
export default app;
